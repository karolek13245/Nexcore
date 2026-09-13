'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const users = require('../users/users');

const SESSIONS_PATH = path.join(__dirname, '..', 'data', 'sessions.json');
const SESSION_COOKIE = 'nexcore_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function loadSessions(){
  try{ return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
  catch(e){ return {}; }
}
function saveSessions(sessions){
  fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function parseCookies(req){
  const header = req.headers.cookie;
  const out = {};
  if(!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if(idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token){
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { userId, createdAt: Date.now() };
  saveSessions(sessions);
  return token;
}
function destroySession(token){
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}

/** Resolves the signed-in user for a request, or null. */
function getSessionUser(req){
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if(!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if(!session) return null;
  const user = users.findById(session.userId);
  return user || null;
}

module.exports = {
  SESSION_COOKIE, parseCookies, setSessionCookie, clearSessionCookie,
  createSession, destroySession, getSessionUser
};
