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
        const data = doc.data();
        // Normalize tone for widgets: "Ray of Sunshine" → "Sunshine"
        if (data.tone === 'Ray of Sunshine') {
          data.tone = 'Sunshine';
        }
        messages.push(data);
      });

      // Shuffle messages so callers always see a random order.
      for (let i = messages.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = messages[i];
        messages[i] = messages[j];
        messages[j] = tmp;
      }

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
          // Include the original document data first, then override with
          // normalized fields expected by the frontend.
          ...data,
          id: doc.id,
          // Common fields expected by the frontend.
          title: data.title || '',
          content: data.content || data.text || '',
          createdAt,
        };
      });

      // Shuffle within this page so the visible order feels random,
      // while pagination still relies on the underlying Firestore cursor.
      for (let i = messages.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = messages[i];
        messages[i] = messages[j];
        messages[j] = tmp;
      }

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
const globalCsvFilePath = path.join(__dirname, 'global_thank_you_grams.csv');
const becauseOfYouCsvPath = path.join(__dirname, 'because_of_you_300_samples.csv');

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

/**
 * Load global seed messages from the global CSV file.
 * @return {Array<object>}
 */
function loadGlobalSeedMessages() {
  const fileContents = fs.readFileSync(globalCsvFilePath, 'utf8');
  const parsed = Papa.parse(fileContents, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => ({
    tone: row.Tone,
    message: row.Message,
    city: row.City,
    country: row.Country,
    date: row.Date,
    location: `${row.City}, ${row.Country}`,
  }));
}

/**
 * Load "because of you" seed messages from the bundled CSV.
 * CSV columns: Tone, Message, City, State, Country, Date
 * @return {Array<object>}
 */
function loadBecauseOfYouSeedMessages() {
  const fileContents = fs.readFileSync(becauseOfYouCsvPath, 'utf8');
  const parsed = Papa.parse(fileContents, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => {
    const city = row.City || '';
    const state = (row.State || '').trim();
    const country = (row.Country || '').trim();
    const location = state
      ? `${city}, ${state}`
      : country
        ? `${city}, ${country}`
        : city || 'Unknown';
    return {
      tone: row.Tone,
      message: row.Message,
      city,
      state,
      country,
      date: row.Date,
      location,
    };
  });
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
        batch.set(ref, {
          ...msg,
          // Ensure the infinite scroll API can order by createdAt.
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          // Provide basic title/content fields expected by getMessages.
          title: msg.tone || 'Message',
          content: msg.message,
        });
      });

      await batch.commit();

      res.json({success: true, count: seedMessages.length});
    } catch (error) {
      console.error('Error seeding messages:', error);
      res.status(500).json({error: 'Failed to seed messages'});
    }
  });
});

/**
 * Seed the "messages" collection with global thank-you grams.
 */
exports.seedGlobalThankYouMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const seedMessages = loadGlobalSeedMessages();

      const batch = db.batch();
      seedMessages.forEach((msg) => {
        const ref = db.collection('messages').doc();
        batch.set(ref, {
          ...msg,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          title: msg.tone || 'Message',
          content: msg.message,
        });
      });

      await batch.commit();

      res.json({success: true, count: seedMessages.length});
    } catch (error) {
      console.error('Error seeding global messages:', error);
      res.status(500).json({error: 'Failed to seed global messages'});
    }
  });
});

/**
 * Seed the "messages" collection with "because of you" samples.
 */
exports.seedBecauseOfYouMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const seedMessages = loadBecauseOfYouSeedMessages();

      const batch = db.batch();
      seedMessages.forEach((msg) => {
        const ref = db.collection('messages').doc();
        batch.set(ref, {
          ...msg,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          title: msg.tone || 'Message',
          content: msg.message,
        });
      });

      await batch.commit();

      res.json({success: true, count: seedMessages.length});
    } catch (error) {
      console.error('Error seeding because-of-you messages:', error);
      res.status(500).json({error: 'Failed to seed because-of-you messages'});
    }
  });
});

// Valid tone values for Thank-you Grams (case-sensitive).
const VALID_TONES = ['Big Hug', 'High Five', 'Coffee Break', 'Sunshine'];

/**
 * Backfill missing "tone" field on existing messages with a random valid tone.
 * Call once via POST to fix documents that don't have tone set.
 */
exports.backfillToneField = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const snapshot = await db.collection('messages').get();
      const BATCH_LIMIT = 500;
      const batches = [];
      let currentBatch = db.batch();
      let opCount = 0;
      let backfilled = 0;

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const hasTone =
          data.tone && VALID_TONES.includes(data.tone);
        if (!hasTone) {
          const randomTone =
            VALID_TONES[Math.floor(Math.random() * VALID_TONES.length)];
          currentBatch.update(doc.ref, {tone: randomTone});
          opCount++;
          backfilled++;
          if (opCount >= BATCH_LIMIT) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            opCount = 0;
          }
        }
      });

      if (opCount > 0) {
        batches.push(currentBatch);
      }
      for (const batch of batches) {
        await batch.commit();
      }

      return res.json({
        success: true,
        backfilled,
        totalDocuments: snapshot.size,
      });
    } catch (error) {
      console.error('Error backfilling tone:', error);
      return res.status(500).json({error: 'Failed to backfill tone field'});
    }
  });
});

/**
 * Seed 8 example messages (2 per tone) for Thank-you Gram structure.
 */
const EXAMPLE_TONE_MESSAGES = [
  {
    tone: 'Big Hug',
    message:
      'Just a heartfelt thank you for being you. You\'re truly one of a kind.',
    location: 'Austin, Texas',
  },
  {
    tone: 'Big Hug',
    message:
      'Sending a warm embrace your way. Your kindness has meant more than you know.',
    location: 'Portland, Oregon',
  },
  {
    tone: 'High Five',
    message:
      'You absolutely crushed it this week! High five from the whole team.',
    location: 'Denver, Colorado',
  },
  {
    tone: 'High Five',
    message:
      'Boom! Another win. Thanks for bringing the energy every single day.',
    location: 'Seattle, Washington',
  },
  {
    tone: 'Coffee Break',
    message:
      'Quick note to say I appreciate your professionalism and hard work.',
    location: 'Boston, Massachusetts',
  },
  {
    tone: 'Coffee Break',
    message:
      'Thanks for the smooth handoff. You\'ve made this project so much easier.',
    location: 'Chicago, Illinois',
  },
  {
    tone: 'Sunshine',
    message:
      'Sending a little sunshine your way! Hope something wonderful happens today.',
    location: 'Miami, Florida',
  },
  {
    tone: 'Sunshine',
    message:
      'You\'re a ray of light. Thanks for always bringing the good vibes.',
    location: 'San Diego, California',
  },
];

exports.seedExampleToneMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({error: 'Method not allowed'});
    }

    try {
      const db = admin.firestore();
      const batch = db.batch();

      EXAMPLE_TONE_MESSAGES.forEach((msg) => {
        const ref = db.collection('messages').doc();
        batch.set(ref, {
          message: msg.message,
          location: msg.location,
          tone: msg.tone,
          title: msg.tone,
          content: msg.message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      await batch.commit();
      return res.json({
        success: true,
        count: EXAMPLE_TONE_MESSAGES.length,
      });
    } catch (error) {
      console.error('Error seeding example tone messages:', error);
      return res.status(500).json({
        error: 'Failed to seed example messages',
      });
    }
  });
});
