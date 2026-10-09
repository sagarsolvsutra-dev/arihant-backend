require('dotenv').config();
const mongoose = require('mongoose');
const Narration = require('./src/models/Narration');
const Company = require('./src/models/Company');

const narrations = [
  { type: 'Accounting', code: 'AC' },
  { type: 'Cheque', code: 'CHQ' },
  { type: 'RTGS', code: 'RTGS' },
  { type: 'NEFT', code: 'NEFT' },
  { type: 'IMPS', code: 'IMPS' },
  { type: 'Cash Receipt', code: 'CR' },
  { type: 'Cash Payment', code: 'CP' },
  { type: 'Invoice Ref', code: 'INV' },
  { type: 'Bill Ref', code: 'BILL' },
  { type: 'Adjustment', code: 'ADJ' }
];

async function seed() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // Timeout after 5s instead of 30s
    });
    console.log('Connected.');
    
    const company = await Company.findOne();
    if (!company) {
      console.log('No company found in database.');
      process.exit(1);
    }
    
    let count = 0;
    for (let n of narrations) {
      const exists = await Narration.findOne({ companyId: company._id, code: n.code });
      if (!exists) {
        await Narration.create({ companyId: company._id, type: n.type, code: n.code });
        count++;
      }
    }
    console.log(`Successfully added ${count} new narrations for company ${company.name}`);
    process.exit(0);
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  }
}

seed();
