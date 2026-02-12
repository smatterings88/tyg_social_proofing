# Messages collection: tone field

## Structure

Each document in the `messages` collection should include:

```javascript
{
  message: "Sending warm gratitude your way!",
  location: "New York, NY",
  tone: "Big Hug",   // one of the four valid values below
  // optional: title, content, createdAt (used by getMessages / infinite scroll)
}
```

## Valid tone values (case-sensitive)

| Tone         | Vibe            |
|-------------|------------------|
| Big Hug     | Soulful & Deep   |
| High Five   | Electric & Hype  |
| Coffee Break| Polished & Kind  |
| Sunshine    | Breezy & Sweet   |

Note: The API normalizes `"Ray of Sunshine"` to `"Sunshine"` in responses so widgets can use one font class.

## Example: add a document with tone (Admin SDK)

```javascript
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

await db.collection('messages').add({
  message: 'Your support made all the difference. Thank you.',
  location: 'Austin, Texas',
  tone: 'Big Hug',
  title: 'Big Hug',
  content: 'Your support made all the difference. Thank you.',
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
});
```

## Example: add documents (client / REST)

Use the Firebase REST API or a backend that has write access; clients typically use Firestore security rules and the client SDK rather than raw REST for writes.

## Backfill existing documents missing `tone`

Call the deployed Cloud Function once (e.g. from a browser console or Postman):

```bash
curl -X POST https://us-central1-thankyougram.cloudfunctions.net/backfillToneField \
  -H "Content-Type: application/json"
```

Response: `{ "success": true, "backfilled": 123, "totalDocuments": 600 }`

## Seed 8 example documents (2 per tone)

```bash
curl -X POST https://us-central1-thankyougram.cloudfunctions.net/seedExampleToneMessages \
  -H "Content-Type: application/json"
```

## API response

`getSocialProofMessages` returns each message as returned by Firestore (including `message`, `location`, `tone`, and any other fields). The `tone` field is included in the JSON response.
