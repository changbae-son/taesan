const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'teasan-f4c17' });
}
const db = admin.firestore();

Promise.all([
  db.collection('stocks').where('name','==','중앙첨단소재').get(),
  db.collection('trades').doc('trade_kiwoom_000000009_051980').get()
]).then(([stockSnap, tradeDoc]) => {
  const stock = stockSnap.docs[0]?.data();
  console.log('totalQty:', stock?.totalQuantity, '| avgPrice:', stock?.avgPrice);
  stock?.buyPlans?.forEach(b => console.log(`  ${b.level}차: ${b.price}원 ${b.quantity}주 filled=${b.filled} filledDate=${b.filledDate||'-'}`));
  console.log('trade exists:', tradeDoc.exists);
  if (tradeDoc.exists) {
    const t = tradeDoc.data();
    console.log(`  ${t.date} [${t.type}] ${t.quantity}주 @${t.price}`);
  }
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
