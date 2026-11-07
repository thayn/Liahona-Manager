// Small CSV reader/writer (handles quotes, commas and newlines inside quotes).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const HEADER_ALIASES = {
  name: ['name', 'full name', 'fullname', 'participant', 'person'],
  first: ['first', 'first name', 'firstname', 'given name'],
  last: ['last', 'last name', 'lastname', 'surname', 'family name'],
  role: ['role', 'type', 'youth/leader', 'kind'],
  ward: ['ward', 'unit', 'branch', 'congregation'],
  age: ['age', 'ages', 'years', 'age (years)'],
  notes: ['notes', 'note', 'comments', 'allergies', 'medical'],
  team: ['team', 'team name', 'group name']
};

function matchHeader(h) {
  const key = h.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

export const AGE_MIN = 13;
export const AGE_MAX = 18;

/** A youth age as a whole number 13-18, or null if blank or out of range. */
export function parseAge(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n >= AGE_MIN && n <= AGE_MAX ? n : null;
}

export function normalizeRole(value) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return 'youth';
  if (['leader', 'adult', 'staff', 'l', 'a', 'counselor', 'counsellor'].includes(v)) return 'leader';
  if (['youth', 'y', 'participant', 'kid', 'camper'].includes(v)) return 'youth';
  return null;
}

/**
 * Turn CSV text into person drafts.
 * Accepts a header row (any column order, common names) or, with no header,
 * a single column of names.
 */
export function csvToPeople(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { people: [], errors: ['The file is empty'] };

  const header = rows[0].map(matchHeader);
  const hasHeader = header.includes('name') || header.includes('first') || header.includes('last');
  const body = hasHeader ? rows.slice(1) : rows;
  const cols = hasHeader ? header : ['name', 'role', 'ward', 'age', 'notes', 'team'];

  const people = [];
  const errors = [];
  body.forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const rec = {};
    cols.forEach((field, j) => { if (field && r[j] !== undefined) rec[field] = r[j].trim(); });
    const name = rec.name || [rec.first, rec.last].filter(Boolean).join(' ');
    if (!name) { errors.push(`Line ${line}: no name`); return; }
    const role = normalizeRole(rec.role);
    if (!role) { errors.push(`Line ${line}: role "${rec.role}" should be Youth or Leader`); return; }
    let age = null;
    if (role === 'youth' && rec.age) {
      age = parseAge(rec.age);
      if (age === null) errors.push(`Line ${line}: ${name}'s age "${rec.age}" isn't ${AGE_MIN}-${AGE_MAX}, left blank`);
    }
    people.push({
      name,
      role,
      ward: rec.ward || '',
      age,
      notes: rec.notes || '',
      team: rec.team || ''
    });
  });
  return { people, errors };
}

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
