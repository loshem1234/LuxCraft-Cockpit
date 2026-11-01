// Claude client plus one-shot document reading (receipts, invoices, images in knowledge folders).
const Anthropic = require('@anthropic-ai/sdk');
const { q } = require('./db');
const S = require('./services');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
let client = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('ANTHROPIC_API_KEY is not set – add it in Railway → Variables to use AI features.'); e.status = 503; throw e;
  }
  if (!client) client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function fileBlock(buffer, mime) {
  const data = buffer.toString('base64');
  if (mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const media = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime) ? mime : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}
async function jobList() {
  const { rows } = await q(`SELECT name, client FROM jobs WHERE status IN ('active','estimating','lead') ORDER BY created_at DESC LIMIT 40`);
  return rows.map((j) => `${j.name}${j.client ? ` (client: ${j.client})` : ''}`).join('; ') || '(none yet)';
}

async function extractDocument(buffer, mime, kind) {
  const today = S.todayISO();
  const jobs = await jobList();
  let tool; let instruction;
  if (kind === 'invoice') {
    tool = {
      name: 'record_invoice', description: 'Record the fields read from a client invoice issued by the contractor.',
      input_schema: { type: 'object', properties: {
        invoice_no: { type: 'string', description: 'Invoice number exactly as printed, e.g. LC-1042' },
        client: { type: 'string' },
        job_name: { type: 'string', description: 'Existing job from the list if it clearly matches, else "<Client> · <Project>"' },
        issue_date: { type: 'string', description: 'YYYY-MM-DD' }, due_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
        amount: { type: 'number', description: 'Amount due on THIS invoice (the draw amount for a progress invoice)' },
        draw_label: { type: 'string', description: 'e.g. "Deposit at start", "Second draw"' },
        notes: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      }, required: ['invoice_no', 'amount', 'confidence'] },
    };
    instruction = `This is an invoice LuxCraft Renovations sent to a client. Read it and call record_invoice. Today is ${today}. Existing jobs: ${jobs}.`;
  } else {
    const { rows } = await q(`SELECT name FROM categories WHERE active AND kind='expense' ORDER BY sort`);
    tool = {
      name: 'record_receipt', description: 'Record the fields read from a purchase receipt for a renovation business.',
      input_schema: { type: 'object', properties: {
        vendor: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
        total: { type: 'number', description: 'Grand total actually paid, including tax' },
        sales_tax: { type: 'number', description: 'Sales tax charged on the receipt; 0 if none shown' },
        category: { type: 'string', enum: rows.map((r) => r.name) },
        method: { type: 'string', enum: ['card', 'cash', 'check', 'ach', 'other'] }, check_no: { type: 'string' },
        summary: { type: 'string', description: 'Short summary of what was bought' },
        job_hint: { type: 'string', description: 'Existing job name if a job/PO/address on the receipt matches one, else empty' },
        mixed: { type: 'boolean', description: 'True if the receipt clearly mixes categories (e.g. materials plus a tool) and should probably be split' },
        line_groups: { type: 'array', description: 'If mixed: subtotal per category including its share of tax', items: { type: 'object', properties: { category: { type: 'string' }, amount: { type: 'number' }, items: { type: 'string' } } } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      }, required: ['vendor', 'total', 'category', 'confidence'] },
    };
    instruction = `This is a receipt for LuxCraft Renovations, a handyman and remodeling business in Ohio. Read it and call record_receipt.
Categories: lumber/drywall/tile/fixtures for client work = Materials; hand and power tools = Tools & Small Equipment; fuel = Fuel / Gas; restaurant = Meals (50%).
Today is ${today}. If the year is missing assume the most recent past date. Existing jobs: ${jobs}.`;
  }
  const resp = await claude().messages.create({
    model: MODEL, max_tokens: 1500, tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: [fileBlock(buffer, mime), { type: 'text', text: instruction }] }],
  });
  const use = resp.content.find((b) => b.type === 'tool_use');
  if (!use) throw new Error('Could not read the document');
  return use.input;
}

async function describeImage(buffer, mime) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  const resp = await claude().messages.create({
    model: MODEL, max_tokens: 3000,
    messages: [{ role: 'user', content: [fileBlock(buffer, mime), { type: 'text', text: 'Transcribe all text in this image exactly, then briefly describe anything else relevant (tables, diagrams, handwriting). Plain text only.' }] }],
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { claude, MODEL, extractDocument, describeImage, fileBlock };
