const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});

admin.initializeApp();

exports.getSocialProofMessages = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Only allow GET requests
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const messagesRef = admin.firestore().collection('messages');
      const snapshot = await messagesRef.get();
      
      if (snapshot.empty) {
        return res.json({ messages: [] });
      }

      const messages = [];
      snapshot.forEach(doc => {
        messages.push(doc.data());
      });

      // Set cache headers (5 minutes)
      res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.json({ messages });
      
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });
});
