require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

// Connexion PostgreSQL avec support SSL automatique pour Neon
const isNeon = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isNeon ? { rejectUnauthorized: false } : false
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 1. ROUTE D'ACCUEIL
app.get('/', (req, res) => {
  res.send('🚀 Serveur FleetPulse SaaS Enterprise actif et connecté !');
});

// 2. RÉCUPÉRER LA FLOTTE
app.get('/api/fleet', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  try {
    const result = await pool.query('SELECT * FROM motos WHERE company_id = $1 ORDER BY id ASC', [companyId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. STATISTIQUES FINANCIÈRES
app.get('/api/finance/stats', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  try {
    const stats = await pool.query(`
      SELECT 
        COALESCE(SUM(cash_on_hand), 0) as total_cash_circulating,
        COALESCE(SUM(trips_today * 2000), 0) as total_revenue,
        COALESCE(SUM(trips_today * 400), 0) as total_commissions
      FROM motos WHERE company_id = $1
    `, [companyId]);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. CLÔTURE DE CAISSE
app.post('/api/finance/collect-cash', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { motoId } = req.body;
  try {
    const result = await pool.query(
      `UPDATE motos SET cash_on_hand = 0, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [motoId, companyId]
    );
    io.to(`company_${companyId}`).emit('cash_collected', { motoId, riderName: result.rows[0]?.rider_name });
    res.json({ success: true, moto: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. MAINTENANCE PMS
app.post('/api/pms/service', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { motoId, typeOperation, cost } = req.body;
  try {
    const motoRes = await pool.query('SELECT odo_km FROM motos WHERE id = $1 AND company_id = $2', [motoId, companyId]);
    const currentOdo = motoRes.rows[0]?.odo_km || 0;

    await pool.query(
      `UPDATE motos SET last_oil_km = $1, status = 'disponible', updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [currentOdo, motoId, companyId]
    );
    await pool.query(
      `INSERT INTO pms_interventions (company_id, moto_id, type_operation, odo_at_service, cost) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, motoId, typeOperation || 'Vidange', currentOdo, cost || 0]
    );

    io.to(`company_${companyId}`).emit('pms_updated', { motoId, lastOilKm: currentOdo });
    res.json({ success: true, odo: currentOdo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. DISPATCHING AUTOMATIQUE DE LA MOTO LA PLUS PROCHE
app.post('/api/orders/dispatch', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { clientNom, ramassage, livraison, pickupLat, pickupLng, dropLat, dropLng } = req.body;

  try {
    const distanceKm = Math.round(calculateDistance(pickupLat, pickupLng, dropLat, dropLng) * 10) / 10;
    const montantLivraison = Math.round(1000 + (distanceKm * 250));

    const motosDispo = await pool.query(`SELECT * FROM motos WHERE company_id = $1 AND status = 'disponible'`, [companyId]);

    if (motosDispo.rows.length === 0) {
      return res.status(400).json({ error: "Aucune moto disponible actuellement dans la flotte !" });
    }

    let motoLaPlusProche = null;
    let distanceMin = Infinity;

    motosDispo.rows.forEach(moto => {
      const d = calculateDistance(moto.lat, moto.lng, pickupLat, pickupLng);
      if (d < distanceMin) {
        distanceMin = d;
        motoLaPlusProche = moto;
      }
    });

    await pool.query(
      `UPDATE motos SET status = 'en_course', cash_on_hand = cash_on_hand + $1, trips_today = trips_today + 1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [montantLivraison, motoLaPlusProche.id, companyId]
    );

    io.to(`company_${companyId}`).emit('nouvelle_course_assignee', {
      motoId: motoLaPlusProche.id,
      clientNom,
      distanceKm,
      montantLivraison,
      ramassage,
      livraison
    });

    res.json({
      success: true,
      motoAssignee: motoLaPlusProche.id,
      livreur: motoLaPlusProche.rider_name,
      distanceKm,
      tarif: montantLivraison
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. WEBSOCKETS TEMPS RÉEL (GPS)
io.on('connection', (socket) => {
  socket.on('join_company', (companyId) => {
    socket.join(`company_${companyId}`);
  });

  socket.on('driver_gps_ping', async (data) => {
    const { companyId, motoId, lat, lng, speed } = data;
    try {
      const prev = await pool.query('SELECT lat, lng, odo_km, last_oil_km FROM motos WHERE id = $1 AND company_id = $2', [motoId, companyId]);
      if (prev.rows.length === 0) return;

      const currentOdo = prev.rows[0].odo_km;
      const lastOil = prev.rows[0].last_oil_km;
      const deltaKm = calculateDistance(prev.rows[0].lat, prev.rows[0].lng, lat, lng);
      const newOdo = currentOdo + deltaKm;

      await pool.query(
        `UPDATE motos SET lat = $1, lng = $2, speed = $3, odo_km = $4, updated_at = NOW() WHERE id = $5 AND company_id = $6`,
        [lat, lng, speed, newOdo, motoId, companyId]
      );

      const needsOil = (newOdo - lastOil) >= 3000;

      io.to(`company_${companyId}`).emit('moto_moved', {
        motoId,
        lat,
        lng,
        speed,
        odoKm: Math.round(newOdo * 10) / 10,
        needsOil
      });
    } catch (err) {
      console.error(err.message);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur FleetPulse SaaS actif sur le port ${PORT}`);
});