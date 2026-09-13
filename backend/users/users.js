'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'users.json');

function loadAll(){
  try{
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }catch(e){
    return [];
  }
}
function saveAll(users){
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored){
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findByEmail(email){
  return loadAll().find(u => u.email === email.toLowerCase());
}
function findById(id){
  return loadAll().find(u => u.id === id);
}

function createUser(email, password){
  email = email.trim().toLowerCase();
  if(!isValidEmail(email)) throw httpError(400, 'Enter a valid email address.');
  if(!password || password.length < 8) throw httpError(400, 'Password needs at least 8 characters.');

  const users = loadAll();
  if(users.some(u => u.email === email)) throw httpError(409, 'An account with that email already exists.');

  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
    quotaBytes: 2 * 1024 ** 3
  };
  users.push(user);
  saveAll(users);
  return user;
}

function authenticate(email, password){
  const user = findByEmail(email);
  if(!user) throw httpError(401, 'No account with that email. Try creating one.');
  if(!verifyPassword(password, user.passwordHash)) throw httpError(401, 'Incorrect password.');
  return user;
}

function httpError(status, message){
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createUser, authenticate, findByEmail, findById, httpError };
