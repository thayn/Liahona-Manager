// Public sign-up form: the field list, checking a submission, and turning an
// approved registration into a person on the roster.
//
// The field list is data, so it can be edited without touching code (and will
// be matched to the old Google Form). Each field:
//   { key, label, type, required, options?, private?, help?, section? }
// type: text | email | tel | date | select | radio | checkbox | textarea | agree | signature | heading
// private: true = contact/health/permission details, only Registrars, Admins and
//          the person's own team leaders can see it.

import crypto from 'node:crypto';
import { HttpError, cleanMap } from './store.js';
import { AGE_MIN, AGE_MAX } from './csv.js';

export const DEFAULT_FORM = [
  { type: 'heading', key: 'h_youth', label: 'About the youth' },
  { key: 'firstName', label: 'First name', type: 'text', required: true },
  { key: 'lastName', label: 'Last name', type: 'text', required: true },
  { key: 'birthdate', label: 'Birth date', type: 'date', required: true, private: true },
  { key: 'gender', label: 'Gender', type: 'radio', options: ['Male', 'Female'], required: true },
  { key: 'ward', label: 'Ward', type: 'text', required: true },
  { key: 'youthEmail', label: 'Youth email (optional)', type: 'email', private: true },
  { key: 'youthPhone', label: 'Youth cell phone (optional)', type: 'tel', private: true },
  { key: 'shirtSize', label: 'T-shirt size', type: 'select', options: ['Youth M', 'Youth L', 'Adult S', 'Adult M', 'Adult L', 'Adult XL', 'Adult 2XL', 'Adult 3XL'] },

  { type: 'heading', key: 'h_parent', label: 'Parent or guardian' },
  { key: 'parentName', label: 'Parent or guardian name', type: 'text', required: true, private: true },
  { key: 'parentEmail', label: 'Parent email', type: 'email', required: true, private: true },
  { key: 'parentPhone', label: 'Parent cell phone', type: 'tel', required: true, private: true },
  { key: 'parent2Name', label: 'Second parent or guardian (optional)', type: 'text', private: true },
  { key: 'parent2Phone', label: 'Second parent phone (optional)', type: 'tel', private: true },

  { type: 'heading', key: 'h_emergency', label: 'Emergency contact', help: 'Someone we can reach if we can\'t reach a parent.' },
  { key: 'emergencyName', label: 'Name', type: 'text', required: true, private: true },
  { key: 'emergencyPhone', label: 'Phone', type: 'tel', required: true, private: true },
  { key: 'emergencyRelation', label: 'Relationship to the youth', type: 'text', private: true },

  { type: 'heading', key: 'h_health', label: 'Health', help: 'Shared only with camp leaders who need it.' },
  { key: 'allergies', label: 'Allergies (food, medicine, insects…)', type: 'textarea', private: true },
  { key: 'medications', label: 'Medications they will bring or need', type: 'textarea', private: true },
  { key: 'conditions', label: 'Medical conditions or physical limitations', type: 'textarea', private: true },
  { key: 'diet', label: 'Dietary needs', type: 'textarea', private: true },
  { key: 'insurance', label: 'Medical insurance company and policy number', type: 'text', private: true },
  { key: 'otherNeeds', label: 'Anything else leaders should know (optional)', type: 'textarea', private: true },

  { type: 'heading', key: 'h_permission', label: 'Parent or guardian permission' },
  { key: 'permission', label: 'I give permission for my child to attend and take part in all camp activities. In an emergency, I authorize leaders to obtain medical treatment for my child if I can\'t be reached.', type: 'agree', required: true, private: true },
  { key: 'photos', label: 'Photos of my child may be shared with camp families and on ward/stake channels', type: 'radio', options: ['Yes', 'No'], required: true, private: true },
  { key: 'signature', label: 'Parent or guardian: type your full name as your signature', type: 'signature', required: true, private: true }
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** Whole years between a YYYY-MM-DD birth date and an "as of" date. */
export function ageOn(birthdate, asOf = new Date()) {
  if (!DATE.test(birthdate || '')) return null;
  const [y, m, d] = birthdate.split('-').map(Number);
  const on = typeof asOf === 'string' && DATE.test(asOf) ? new Date(`${asOf}T12:00:00`) : new Date(asOf);
  let age = on.getFullYear() - y;
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) age--;
  return age;
}

/**
 * Check a submission against the form. Returns { answers, errors } where
 * answers only holds known fields, cleaned.
 */
export function checkSubmission(form, input) {
  const answers = {};
  const errors = [];
  for (const f of form) {
    if (f.type === 'heading') continue;
    const raw = input?.[f.key];
    let v;
    if (f.type === 'agree' || f.type === 'checkbox') v = raw === true || raw === 'true' || raw === 'on' || raw === 'yes';
    else v = clean(raw, f.type === 'textarea' ? 2000 : 200);
    if (f.required && (v === '' || v === false)) { errors.push({ key: f.key, message: `${f.label.split('(')[0].trim()} is required` }); continue; }
    if (v === '' || v === false) { answers[f.key] = v; continue; }
    if (f.type === 'email' && !EMAIL.test(v)) errors.push({ key: f.key, message: 'That email doesn\'t look right' });
    if (f.type === 'date' && !DATE.test(v)) errors.push({ key: f.key, message: 'Use a full date' });
    if ((f.type === 'select' || f.type === 'radio') && f.options && !f.options.includes(v)) errors.push({ key: f.key, message: 'Pick one of the choices' });
    if (f.type === 'signature' && v.split(/\s+/).length < 2) errors.push({ key: f.key, message: 'Type your first and last name' });
    answers[f.key] = v;
  }
  return { answers, errors };
}

/** Add a public submission as a pending registration. Returns a receipt. */
export function addRegistration(store, input, { ip = '' } = {}) {
  const ev = store.db.settings.event || {};
  if (!ev.registrationOpen) throw new HttpError(403, 'Registration is closed right now');
  // Bot traps: a hidden field people never fill, and forms sent too fast.
  if (input?.website) throw new HttpError(400, 'Something went wrong. Please try again.');
  if (Number(input?._started) && Date.now() - Number(input._started) < 4000) throw new HttpError(400, 'Something went wrong. Please try again.');
  if (store.db.registrations.length >= 2000) throw new HttpError(503, 'Registration is full. Please contact the camp leaders.');

  const form = store.db.settings.form || DEFAULT_FORM;
  const { answers, errors } = checkSubmission(form, input?.answers || input);
  if (errors.length) throw new HttpError(400, errors[0].message, { errors });

  const key = `${answers.firstName} ${answers.lastName} ${answers.birthdate || ''}`.toLowerCase();
  const duplicateOf = store.db.registrations.find(r => r.status !== 'rejected' && r.matchKey === key)?.id || null;
  const reg = {
    id: `r_${crypto.randomBytes(5).toString('hex')}`,
    submittedAt: new Date().toISOString(),
    status: 'pending',
    matchKey: key,
    duplicateOf,
    answers,
    signedBy: answers.signature || '',
    signedAt: new Date().toISOString(),
    ipHash: ip ? crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16) : ''
  };
  store.db.registrations.push(reg);
  store.save();
  return { id: reg.id, name: `${answers.firstName} ${answers.lastName}`, duplicate: !!duplicateOf };
}

/** Turn a pending registration into a person on the roster. */
export function approveRegistration(store, id, { by = '' } = {}) {
  const reg = store.db.registrations.find(r => r.id === id);
  if (!reg) throw new HttpError(404, 'Registration not found');
  if (reg.status === 'approved') throw new HttpError(409, 'Already approved');
  const form = store.db.settings.form || DEFAULT_FORM;
  const a = reg.answers;
  const profile = {};
  const priv = {};
  for (const f of form) {
    if (f.type === 'heading' || ['firstName', 'lastName', 'ward'].includes(f.key)) continue;
    if (a[f.key] === undefined || a[f.key] === '') continue;
    (f.private ? priv : profile)[f.key] = a[f.key];
  }
  priv.registrationId = reg.id;
  priv.signedBy = reg.signedBy;
  priv.signedAt = reg.signedAt;
  const ev = store.db.settings.event || {};
  let age = ageOn(a.birthdate, ev.startDate || new Date());
  if (age !== null && (age < AGE_MIN || age > AGE_MAX)) age = null;   // outside the youth range: a Registrar fixes it
  const person = store.addPerson({
    name: `${a.firstName} ${a.lastName}`,
    role: 'youth',
    ward: a.ward || '',
    age: age ?? '',
    email: a.youthEmail || '',
    profile: cleanMap({ firstName: a.firstName, lastName: a.lastName, ...profile }),
    private: cleanMap(priv)
  });
  reg.status = 'approved';
  reg.personId = person.id;
  reg.decidedAt = new Date().toISOString();
  reg.decidedBy = by;
  store.save();
  return { registration: reg, person };
}

export function rejectRegistration(store, id, { by = '', reason = '' } = {}) {
  const reg = store.db.registrations.find(r => r.id === id);
  if (!reg) throw new HttpError(404, 'Registration not found');
  if (reg.status === 'approved') throw new HttpError(409, 'Already approved; remove the person from People instead');
  reg.status = 'rejected';
  reg.reason = clean(reason, 300);
  reg.decidedAt = new Date().toISOString();
  reg.decidedBy = by;
  store.save();
  return reg;
}

export function deleteRegistration(store, id) {
  const before = store.db.registrations.length;
  store.db.registrations = store.db.registrations.filter(r => r.id !== id);
  if (store.db.registrations.length === before) throw new HttpError(404, 'Registration not found');
  store.save();
}
