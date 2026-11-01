// Encrypted file storage and text extraction for agent knowledge folders.
const { q } = require('./db');
const SEC = require('./security');

const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
const DOC_TYPES = [...RECEIPT_TYPES, 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

async function saveAttachment(file, allowed = RECEIPT_TYPES) {
  const mime = SEC.sniffType(file.buffer, file.mimetype, file.originalname);
  if (!mime || !allowed.includes(mime)) {
    const e = new Error('That file type is not allowed. Use a photo, PDF, Word (.docx), or text/CSV file.'); e.status = 400; throw e;
  }
  const name = String(file.originalname || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const { rows } = await q('INSERT INTO attachments (filename, mime, size, data, encrypted) VALUES ($1,$2,$3,$4,true) RETURNING id',
    [name, mime, file.size, SEC.encrypt(file.buffer)]);
  return { id: rows[0].id, mime, filename: name };
}
async function loadAttachment(id) {
  const { rows } = await q('SELECT filename, mime, data, encrypted FROM attachments WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const r = rows[0];
  return { filename: r.filename, mime: r.mime, data: r.encrypted ? SEC.decrypt(r.data) : r.data };
}

async function extractText(buffer, mime, describeImage) {
  if (mime === 'application/pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try { const r = await parser.getText(); return (r.text || '').trim(); } finally { await parser.destroy().catch(() => {}); }
  }
  if (mime.includes('wordprocessingml')) {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer })).value.trim();
  }
  if (mime.startsWith('text/') || mime === 'application/json') return buffer.toString('utf8').trim();
  if (mime.startsWith('image/') && describeImage) return (await describeImage(buffer, mime)).trim();
  return '';
}

// ---------- agent knowledge folders ----------
async function addDoc(agent, file, note, describeImage) {
  const att = await saveAttachment(file, DOC_TYPES);
  let text = '';
  try { text = await extractText(file.buffer, att.mime, describeImage); } catch (e) { text = ''; }
  const { rows } = await q(
    `INSERT INTO agent_docs (agent, filename, mime, size, attachment_id, text_enc, chars, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, agent, filename, mime, size, chars, note, created_at`,
    [agent, att.filename, att.mime, file.size, att.id, text ? SEC.encrypt(text) : null, text.length, note || null]);
  return rows[0];
}
async function listDocs(agent) {
  const { rows } = await q(`SELECT id, agent, filename, mime, size, chars, note, attachment_id, created_at FROM agent_docs
     WHERE ($1::text IS NULL OR agent=$1) ORDER BY created_at DESC`, [agent || null]);
  return rows;
}
async function docTexts(agents) {
  const { rows } = await q('SELECT id, agent, filename, note, text_enc FROM agent_docs WHERE agent = ANY($1) AND text_enc IS NOT NULL ORDER BY created_at', [agents]);
  return rows.map((r) => ({ id: r.id, agent: r.agent, filename: r.filename, note: r.note, text: SEC.decrypt(r.text_enc).toString('utf8') }));
}
async function deleteDoc(id) {
  const { rows } = await q('DELETE FROM agent_docs WHERE id=$1 RETURNING attachment_id', [id]);
  if (rows[0] && rows[0].attachment_id) await q('DELETE FROM attachments WHERE id=$1', [rows[0].attachment_id]);
}
// Simple keyword search across an agent's documents (used when they're too long to include whole).
function searchDocs(docs, query, limit = 6) {
  const terms = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const hits = [];
  for (const d of docs) {
    const paras = d.text.split(/\n\s*\n|(?<=\.)\s{2,}/);
    let buf = '';
    const chunks = [];
    for (const p of paras) { if ((buf + p).length > 1500) { if (buf) chunks.push(buf); buf = p; } else buf += (buf ? '\n\n' : '') + p; }
    if (buf) chunks.push(buf);
    chunks.forEach((c, i) => {
      const low = c.toLowerCase();
      const score = terms.reduce((s, t) => s + (low.split(t).length - 1), 0);
      if (score) hits.push({ doc: d.filename, part: i + 1, score, text: c });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { saveAttachment, loadAttachment, addDoc, listDocs, docTexts, deleteDoc, searchDocs, RECEIPT_TYPES, DOC_TYPES };
