const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

admin.initializeApp();

/**
 * Simple GET endpoint used by the existing GHL social proof integration.
 */
exports.getSocialProofMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Only allow GET requests
    if (req.method !== 'GET') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const messagesRef = admin.firestore().collection('messages');
      const snapshot = await messagesRef.get();

      if (snapshot.empty) {
        return res.json({messages: []});
      }

      const messages = [];
      snapshot.forEach((doc) => {
        messages.push(doc.data());
      });

      // Set cache headers (5 minutes)
      res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.json({messages});
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({error: 'Failed to fetch messages'});
    }
  });
});

/**
 * Paginated messages API for infinite scroll grids.
 *
 * Request (POST JSON body):
 *  {
 *    "lastDocId": "<optional Firestore document id>",
 *    "limit": 20 // optional, default 20, max 50
 *  }
 *
 * Response:
 *  {
 *    "messages": [ { id, title, content, createdAt, ... } ],
 *    "lastDocId": "<id of last doc in this page or null>",
 *    "hasMore": true|false
 *  }
 */
exports.getMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const body = req.body || {};

      let {lastDocId, limit} = body;

      // Basic validation and sensible defaults.
      if (typeof limit !== 'number') {
        limit = 20;
      }
      if (limit <= 0) {
        limit = 20;
      }
      if (limit > 50) {
        limit = 50;
      }

      let query = db.collection('messages')
          .orderBy('createdAt', 'desc')
          .limit(limit);

      if (lastDocId) {
        const lastDocRef = db.collection('messages').doc(String(lastDocId));
        const lastDocSnap = await lastDocRef.get();

        if (lastDocSnap.exists) {
          query = query.startAfter(lastDocSnap);
        } else {
          // If the client sent an invalid cursor, ignore it and treat as first page.
          lastDocId = null;
        }
      }

      const snapshot = await query.get();

      const messages = snapshot.docs.map((doc) => {
        const data = doc.data() || {};
        let createdAt = data.createdAt || null;
        if (createdAt && typeof createdAt.toDate === 'function') {
          createdAt = createdAt.toDate().toISOString();
        }

        return {
          id: doc.id,
          // Common fields expected by the frontend.
          title: data.title || '',
          content: data.content || data.text || '',
          createdAt,
          // Include the rest of the document in case it's useful.
          ...data,
        };
      });

      const lastVisible = snapshot.docs[snapshot.docs.length - 1] || null;
      const nextLastDocId = lastVisible ? lastVisible.id : null;
      const hasMore = snapshot.size === limit;

      return res.json({
        messages,
        lastDocId: nextLastDocId,
        hasMore,
      });
    } catch (error) {
      console.error('Error fetching paginated messages:', error);
      return res.status(500).json({error: 'Failed to fetch messages'});
    }
  });
});

const csvFilePath = path.join(__dirname, 'thank_you_grams.csv');

/**
 * Load seed messages from the bundled CSV file.
 * @return {Array<object>}
 */
function loadSeedMessages() {
  const fileContents = fs.readFileSync(csvFilePath, 'utf8');
  const parsed = Papa.parse(fileContents, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => ({
    tone: row.Tone,
    message: row.Message,
    city: row.City,
    state: row.State,
    date: row.Date,
    location: `${row.City}, ${row.State}`,
  }));
}

exports.seedThankYouMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const seedMessages = loadSeedMessages();

      const batch = db.batch();
      seedMessages.forEach((msg) => {
        const ref = db.collection('messages').doc();
        batch.set(ref, msg);
      });

      await batch.commit();

      res.json({success: true, count: seedMessages.length});
    } catch (error) {
      console.error('Error seeding messages:', error);
      res.status(500).json({error: 'Failed to seed messages'});
    }
  });
});
