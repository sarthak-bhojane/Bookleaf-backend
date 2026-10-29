import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authors as seedAuthors, admin as seedAdmin } from './seed.js';
import { classifyTicket, draftResponse } from './ai.js';

const app = express();
const port = Number(process.env.PORT) || 4000;
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const jwtSecret = process.env.JWT_SECRET || 'local-development-secret-change-me';
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const storePath = path.join(dataDir, 'store.json');
const attachmentDir = path.join(dataDir, 'attachments');
const statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
const categories = ['Royalty & Payments', 'ISBN & Metadata Issues', 'Printing & Quality', 'Distribution & Availability', 'Book Status & Production Updates', 'General Inquiry'];
const priorities = ['Critical', 'High', 'Medium', 'Low'];
const allowedAttachments = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3, fieldSize: 5000 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowedAttachments.get(extension) !== file.mimetype) {
      const error = new Error('Attach a PDF, PNG, JPG, or WEBP file.');
      error.code = 'UNSUPPORTED_ATTACHMENT';
      return callback(error);
    }
    return callback(null, true);
  },
});
let store;
let writeQueue = Promise.resolve();

const allowedOrigins = new Set([
  'http://localhost:3000',
  'https://bookleaf-frontend-nu.vercel.app',
  ...(process.env.CLIENT_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean) || []),
]);

app.use(cors({ origin: [...allowedOrigins] }));
app.use(express.json({ limit: '1mb' }));

function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  const write = writeQueue.catch(() => {}).then(async () => {
    const temporary = `${storePath}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, storePath);
  });
  writeQueue = write;
  return write;
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

async function initialize() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(attachmentDir, { recursive: true });
  try {
    store = JSON.parse(await readFile(storePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const authors = await Promise.all(seedAuthors.map(async (author) => ({
      ...author,
      passwordHash: await bcrypt.hash(author.password, 10),
      password: undefined,
    })));
    const admin = {
      ...seedAdmin,
      role: 'admin',
      passwordHash: await bcrypt.hash(seedAdmin.password, 10),
      password: undefined,
    };
    store = { authors, admin, tickets: [] };
    await persist();
  }
}

const publicUser = ({ id, name, email, role, city, joinedDate }) => ({ id, name, email, role, city, joinedDate });
const sendError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in to continue.');
  try {
    req.user = jwt.verify(header.slice(7), jwtSecret);
    next();
  } catch {
    return sendError(res, 401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');
  }
}

const requireAdmin = (req, res, next) => req.user.role === 'admin'
  ? next()
  : sendError(res, 403, 'FORBIDDEN', 'This action is for operations team members only.');

function findAuthor(id) {
  return store.authors.find(author => author.id === id);
}

function canViewTicket(ticket, user) {
  return user.role === 'admin' || ticket.authorId === user.id;
}

function validateText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) return `${label} is required.`;
  if (value.trim().length > maximum) return `${label} must be ${maximum} characters or fewer.`;
  return null;
}

function validAttachmentSignature(file) {
  const buffer = file.buffer;
  if (file.mimetype === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if (file.mimetype === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (file.mimetype === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}

function serializeTicket(ticket, includeNotes = true) {
  const { notes = [], attachments = [], ...fields } = ticket;
  return {
    ...fields,
    attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })),
    ...(includeNotes ? { notes } : {}),
  };
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) return sendError(res, 400, 'VALIDATION_ERROR', 'Email and password are required.');
  const account = [store.admin, ...store.authors].find(user => user.email.toLowerCase() === email);
  if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  const user = { id: account.id, role: account.role || 'author' };
  const token = jwt.sign(user, jwtSecret, { expiresIn: '12h' });
  return res.json({ token, user: publicUser({ ...account, role: user.role }) });
}));

app.get('/api/auth/me', authenticate, (req, res) => {
  const account = req.user.role === 'admin' ? store.admin : findAuthor(req.user.id);
  if (!account) return sendError(res, 401, 'ACCOUNT_NOT_FOUND', 'This account is no longer available.');
  return res.json({ user: publicUser({ ...account, role: req.user.role }) });
});

app.get('/api/books', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ books: store.authors.flatMap(author => author.books.map(book => ({ ...book, authorId: author.id, authorName: author.name }))) });
  }
  const author = findAuthor(req.user.id);
  if (!author) return sendError(res, 404, 'AUTHOR_NOT_FOUND', 'Author account was not found.');
  return res.json({ books: author.books });
});

app.get('/api/authors', authenticate, requireAdmin, (_req, res) => {
  res.json({ authors: store.authors.map(author => publicUser({ ...author, role: 'author' })) });
});

app.get('/api/tickets', authenticate, (req, res) => {
  let tickets = req.user.role === 'admin' ? store.tickets : store.tickets.filter(ticket => ticket.authorId === req.user.id);
  const { status, category, priority, q } = req.query;
  if (status && !statuses.includes(status)) return sendError(res, 400, 'INVALID_STATUS', 'Choose a supported ticket status.');
  if (category && !categories.includes(category)) return sendError(res, 400, 'INVALID_CATEGORY', 'Choose a supported ticket category.');
  if (priority && !priorities.includes(priority)) return sendError(res, 400, 'INVALID_PRIORITY', 'Choose a supported priority.');
  if (status) tickets = tickets.filter(ticket => ticket.status === status);
  if (category) tickets = tickets.filter(ticket => ticket.category === category);
  if (priority) tickets = tickets.filter(ticket => ticket.priority === priority);
  if (q) {
    const query = String(q).toLowerCase();
    tickets = tickets.filter(ticket => `${ticket.subject} ${ticket.description} ${ticket.authorName}`.toLowerCase().includes(query));
  }
  tickets = [...tickets].sort((a, b) => {
    const unresolvedOrder = Number(['Resolved', 'Closed'].includes(a.status)) - Number(['Resolved', 'Closed'].includes(b.status));
    if (unresolvedOrder) return unresolvedOrder;
    const priorityOrder = priorities.indexOf(a.priority) - priorities.indexOf(b.priority);
    return priorityOrder || new Date(a.createdAt) - new Date(b.createdAt);
  });
  return res.json({ tickets: tickets.map(ticket => serializeTicket(ticket, req.user.role === 'admin')) });
});

app.post('/api/tickets', authenticate, upload.single('attachment'), asyncRoute(async (req, res) => {
  if (req.user.role !== 'author') return sendError(res, 403, 'FORBIDDEN', 'Only authors can submit a support request.');
  const subjectError = validateText(req.body?.subject, 'Subject', 140);
  const descriptionError = validateText(req.body?.description, 'Description', 5000);
  if (subjectError || descriptionError) return sendError(res, 400, 'VALIDATION_ERROR', subjectError || descriptionError);
  const author = findAuthor(req.user.id);
  const bookId = req.body.bookId === 'general' || !req.body.bookId ? null : String(req.body.bookId);
  if (bookId && !author?.books.some(book => book.id === bookId)) return sendError(res, 400, 'INVALID_BOOK', 'Choose one of your books or General / Account Level.');
  if (req.file && !validAttachmentSignature(req.file)) return sendError(res, 400, 'INVALID_ATTACHMENT', 'The selected file does not match its file type.');
  const classification = await classifyTicket(req.body.subject.trim(), req.body.description.trim());
  const attachments = [];
  if (req.file) {
    const extension = path.extname(req.file.originalname).toLowerCase();
    const storageName = `${randomUUID()}${extension}`;
    const originalName = path.basename(req.file.originalname.replace(/\\/g, '/'))
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 150) || `attachment${extension}`;
    attachments.push({
      id: randomUUID(),
      name: originalName,
      type: req.file.mimetype,
      size: req.file.size,
      storageName,
    });
    await writeFile(path.join(attachmentDir, storageName), req.file.buffer, { flag: 'wx' });
  }
  const ticket = {
    id: `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    authorId: author.id,
    authorName: author.name,
    bookId,
    subject: req.body.subject.trim(),
    description: req.body.description.trim(),
    status: 'Open',
    category: classification.category,
    categorySource: classification.source,
    priority: classification.priority,
    prioritySource: classification.source,
    assignee: null,
    messages: [],
    notes: [],
    attachments,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.tickets.push(ticket);
  try {
    await persist();
  } catch (error) {
    store.tickets = store.tickets.filter(item => item.id !== ticket.id);
    await Promise.all(attachments.map(item => unlink(path.join(attachmentDir, item.storageName)).catch(() => {})));
    throw error;
  }
  return res.status(201).json({ ticket: serializeTicket(ticket) });
}));

app.get('/api/tickets/:id', authenticate, (req, res) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  if (!canViewTicket(ticket, req.user)) return sendError(res, 403, 'FORBIDDEN', 'You can only view your own tickets.');
  return res.json({ ticket: serializeTicket(ticket, req.user.role === 'admin') });
});

app.get('/api/tickets/:id/attachments/:attachmentId', authenticate, (req, res, next) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  if (!canViewTicket(ticket, req.user)) return sendError(res, 403, 'FORBIDDEN', 'You can only access attachments on your own tickets.');
  const attachment = (ticket.attachments || []).find(item => item.id === req.params.attachmentId);
  if (!attachment) return sendError(res, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment was not found.');
  const safeName = attachment.name.replace(/["\\\r\n]/g, '_');
  res.setHeader('Content-Type', attachment.type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.sendFile(path.join(attachmentDir, attachment.storageName), error => {
    if (error && !res.headersSent) next(error);
  });
});

app.patch('/api/tickets/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  const { status, category, priority, assignToMe } = req.body || {};
  if (status !== undefined && !statuses.includes(status)) return sendError(res, 400, 'INVALID_STATUS', `Status must be one of: ${statuses.join(', ')}.`);
  if (category !== undefined && !categories.includes(category)) return sendError(res, 400, 'INVALID_CATEGORY', 'Choose a supported ticket category.');
  if (priority !== undefined && !priorities.includes(priority)) return sendError(res, 400, 'INVALID_PRIORITY', 'Choose a supported priority.');
  if (status !== undefined) ticket.status = status;
  if (category !== undefined) { ticket.category = category; ticket.categorySource = 'admin'; }
  if (priority !== undefined) { ticket.priority = priority; ticket.prioritySource = 'admin'; }
  if (assignToMe === true) ticket.assignee = store.admin.name;
  if (assignToMe === false) ticket.assignee = null;
  ticket.updatedAt = new Date().toISOString();
  await persist();
  return res.json({ ticket: serializeTicket(ticket) });
}));

app.post('/api/tickets/:id/messages', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  const messageError = validateText(req.body?.text, 'Reply', 5000);
  if (messageError) return sendError(res, 400, 'VALIDATION_ERROR', messageError);
  const message = { id: `MSG-${Date.now()}`, authorId: req.user.id, authorName: store.admin.name, text: req.body.text.trim(), createdAt: new Date().toISOString() };
  ticket.messages.push(message);
  if (ticket.status === 'Open') ticket.status = 'In Progress';
  ticket.updatedAt = message.createdAt;
  await persist();
  return res.status(201).json({ message, ticket: serializeTicket(ticket) });
}));

app.post('/api/tickets/:id/notes', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  const noteError = validateText(req.body?.text, 'Note', 2000);
  if (noteError) return sendError(res, 400, 'VALIDATION_ERROR', noteError);
  const note = { id: `NOTE-${Date.now()}`, authorName: store.admin.name, text: req.body.text.trim(), createdAt: new Date().toISOString() };
  ticket.notes.push(note);
  ticket.updatedAt = note.createdAt;
  await persist();
  return res.status(201).json({ note });
}));

app.post('/api/tickets/:id/draft', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const ticket = store.tickets.find(item => item.id === req.params.id);
  if (!ticket) return sendError(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.');
  const author = findAuthor(ticket.authorId);
  const book = author?.books.find(item => item.id === ticket.bookId);
  const draft = await draftResponse(ticket, author, book);
  return res.json({ draft: draft.text, source: draft.source });
}));

app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'This API endpoint does not exist.'));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 413, 'ATTACHMENT_TOO_LARGE', 'Attachments must be 5 MB or smaller.');
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_COUNT') return sendError(res, 400, 'VALIDATION_ERROR', 'Ticket fields exceed the allowed size or count.');
    return sendError(res, 400, 'INVALID_ATTACHMENT', 'Only one attachment can be uploaded per ticket.');
  }
  if (err.code === 'UNSUPPORTED_ATTACHMENT') return sendError(res, 400, 'UNSUPPORTED_ATTACHMENT', err.message);
  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
});

await initialize();
app.listen(port, () => console.log(`BookLeaf API listening on http://localhost:${port}`));
