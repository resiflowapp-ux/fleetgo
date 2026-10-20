require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// Autoriser le dashboard web à communiquer avec le backend
app.use(cors({ origin: '*' }));
app.use(express.json());

// Connexion PostgreSQL (avec support SSL automatique pour Neon.tech)
const isNeon = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isNeon ? { rejectUnauthorized: false } : false
});

// Initialisation de Socket.io pour la communication GPS en temps réel
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --- HELPER : Calcul de distance GPS (Formule de Haversine en km) ---
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Rayon moyen de la Terre en km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ==========================================
// 1. ROUTES DE TEST ET ENDPOINTS REST
// ==========================================

// Test simple pour vérifier que l'API tourne
app.get('/', (req, res) => {
  res.send('🚀 Serveur FleetPulse SaaS en ligne et connecté !');
});

// Récupérer la flotte de motos de l'entreprise
app.get('/api/fleet', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  if (!companyId) return res.status(400).json({ error: 'Company ID requis dans les headers (x-company-id)' });

  try {
    const result = await pool.query(
      'SELECT * FROM motos WHERE company_id = $1 ORDER BY id ASC',
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lecture flotte:', err.message);
    res.status(500).json({ error: 'Erreur serveur BDD' });
  }
});

// Récupérer les statistiques financières globales
app.get('/api/finance/stats', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  try {
    const stats = await pool.query(`
      SELECT 
        COALESCE(SUM(cash_on_hand), 0) as total_cash_circulating,
        COALESCE(SUM(trips_today * 2000), 0) as total_revenue,
        COALESCE(SUM(trips_today * 400), 0) as total_commissions
      FROM motos 
      WHERE company_id = $1
    `, [companyId]);

    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Valider la clôture de caisse d'un livreur (Encaissement physique des espèces)
app.post('/api/finance/collect-cash', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { motoId } = req.body;

  try {
    const result = await pool.query(
      `UPDATE motos 
       SET cash_on_hand = 0, updated_at = NOW() 
       WHERE id = $1 AND company_id = $2 
       RETURNING *`,
      [motoId, companyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Moto introuvable' });
    }

    // Informer le dashboard de l'encaissement en temps réel
    io.to(`company_${companyId}`).emit('cash_collected', {
      motoId,
      riderName: result.rows[0].rider_name,
      timestamp: new Date()
    });

    res.json({ success: true, moto: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Valider une vidange / entretien (Module PMS)
app.post('/api/pms/service', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { motoId, typeOperation, cost } = req.body;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lire le kilométrage actuel
      const motoRes = await client.query(
        'SELECT odo_km FROM motos WHERE id = $1 AND company_id = $2',
        [motoId, companyId]
      );
      const currentOdo = motoRes.rows[0]?.odo_km || 0;

      // 2. Réinitialiser le cycle d'entretien
      await client.query(
        `UPDATE motos 
         SET last_oil_km = $1, status = 'disponible', updated_at = NOW() 
         WHERE id = $2 AND company_id = $3`,
        [currentOdo, motoId, companyId]
      );

      // 3. Enregistrer l'opération dans le journal PMS
      await client.query(
        `INSERT INTO pms_interventions (company_id, moto_id, type_operation, odo_at_service, cost) 
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, motoId, typeOperation || 'Vidange', currentOdo, cost || 0]
      );

      await client.query('COMMIT');

      // Alerte temps réel sur le tableau de bord
      io.to(`company_${companyId}`).emit('pms_updated', { motoId, lastOilKm: currentOdo });
      res.json({ success: true, odo: currentOdo });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- CRÉATION DE COMMANDE & DISPATCH AUTOMATIQUE DE LA MOTO LA PLUS PROCHE ---
app.post('/api/orders/dispatch', async (req, res) => {
  const companyId = req.headers['x-company-id'];
  const { clientNom, ramassage, livraison, pickupLat, pickupLng, dropLat, dropLng } = req.body;

  try {
    // 1. Calculer la distance de livraison (en km)
    const distanceKm = Math.round(calculateDistance(pickupLat, pickupLng, dropLat, dropLng) * 10) / 10;
    
    // 2. Calcul du tarif : Forfait de base 1 000 FCFA + 250 FCFA par km
    const montantLivraison = Math.round(1000 + (distanceKm * 250));
    const commissionLivreur = Math.round(montantLivraison * 0.20); // 20% pour le motard

    // 3. Trouver la moto DISPONIBLE la plus proche du lieu de ramassage
    const motosDispo = await pool.query(
      `SELECT * FROM motos WHERE company_id = $1 AND status = 'disponible'`,
      [companyId]
    );

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

    // 4. Assigner la course à cette moto et la passer en statut "en_course"
    await pool.query(
      `UPDATE motos 
       SET status = 'en_course', 
           cash_on_hand = cash_on_hand + $1, 
           trips_today = trips_today + 1,
           updated_at = NOW() 
       WHERE id = $2 AND company_id = $3`,
      [montantLivraison, motoLaPlusProche.id, companyId]
    );

    // 5. Alerter le Dashboard et le Livreur en temps réel
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
    console.error('Erreur dispatch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. TEMPS RÉEL VIA SOCKET.IO (GPS)
// ==========================================

io.on('connection', (socket) => {
  console.log(`🔌 Nouveau client connecté : ${socket.id}`);

  // Le dashboard rejoint la salle privée de son entreprise
  socket.on('join_company', (companyId) => {
    socket.join(`company_${companyId}`);
    console.log(`Client ${socket.id} a rejoint la salle : company_${companyId}`);
  });

  // Réception de la position GPS d'un motard
  socket.on('driver_gps_ping', async (data) => {
    const { companyId, motoId, lat, lng, speed } = data;

    try {
      // 1. Récupérer l'ancienne position pour calculer le kilométrage ajouté
      const prev = await pool.query(
        'SELECT lat, lng, odo_km, last_oil_km FROM motos WHERE id = $1 AND company_id = $2',
        [motoId, companyId]
      );

      if (prev.rows.length === 0) return;

      const oldLat = prev.rows[0].lat;
      const oldLng = prev.rows[0].lng;
      const currentOdo = prev.rows[0].odo_km;
      const lastOil = prev.rows[0].last_oil_km;

      // Calcul de la distance parcourue depuis le dernier ping
      const deltaKm = calculateDistance(oldLat, oldLng, lat, lng);
      const newOdo = currentOdo + deltaKm;

      // 2. Mettre à jour la base de données
      await pool.query(
        `UPDATE motos 
         SET lat = $1, lng = $2, speed = $3, odo_km = $4, updated_at = NOW() 
         WHERE id = $5 AND company_id = $6`,
        [lat, lng, speed, newOdo, motoId, companyId]
      );

      // 3. Détecter si la moto dépasse le cycle de 3 000 km pour la vidange
      const needsOil = (newOdo - lastOil) >= 3000;

      // 4. Diffuser la mise à jour aux écrans de supervision de l'entreprise
      io.to(`company_${companyId}`).emit('moto_moved', {
        motoId,
        lat,
        lng,
        speed,
        odoKm: Math.round(newOdo * 10) / 10,
        needsOil
      });

    } catch (err) {
      console.error('Erreur ingestion GPS:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté');
  });
});

// Lancement de l'écoute HTTP & WebSocket
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur FleetPulse SaaS actif sur http://localhost:${PORT}`);
});