'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../users/users');

const NODES_PATH = path.join(__dirname, '..', 'data', 'nodes.json');
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'files');
const TMP_ROOT = path.join(__dirname, '..', 'data', 'tmp');

fs.mkdirSync(STORAGE_ROOT, { recursive: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

function loadNodes(){
  try{ return JSON.parse(fs.readFileSync(NODES_PATH, 'utf8')); }
  catch(e){ return []; }
}
function saveNodes(nodes){
  fs.mkdirSync(path.dirname(NODES_PATH), { recursive: true });
  fs.writeFileSync(NODES_PATH, JSON.stringify(nodes, null, 2));
}

function userDir(ownerId){
  const dir = path.join(STORAGE_ROOT, ownerId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newTempPath(){
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return path.join(TMP_ROOT, crypto.randomUUID() + '.part');
}

function getNode(id){
  return loadNodes().find(n => n.id === id);
}

function assertOwned(node, ownerId){
  if(!node || node.ownerId !== ownerId) throw httpError(404, 'Not found.');
  return node;
}

function listChildren(ownerId, parentId){
  return loadNodes()
    .filter(n => n.ownerId === ownerId && (n.parentId || null) === (parentId || null))
    .sort((a,b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1));
}

function validateName(name){
  const trimmed = (name || '').trim();
  if(!trimmed) throw httpError(400, 'Name cannot be empty.');
  if(trimmed.length > 255) throw httpError(400, 'Name is too long.');
  if(/[\/\\]/.test(trimmed)) throw httpError(400, 'Name cannot contain slashes.');
  return trimmed;
}

function createFolder(ownerId, parentId, name){
  const nodes = loadNodes();
  if(parentId){
    assertOwned(nodes.find(n => n.id === parentId), ownerId);
  }
  const node = {
    id: crypto.randomUUID(),
    ownerId,
    parentId: parentId || null,
    type: 'folder',
    name: validateName(name),
    createdAt: Date.now()
  };
  nodes.push(node);
  saveNodes(nodes);
  return node;
}

function usageBytes(ownerId){
  return loadNodes()
    .filter(n => n.ownerId === ownerId && n.type === 'file')
    .reduce((sum, n) => sum + (n.size || 0), 0);
}

/** Moves an already-safety-checked temp file into permanent storage and records it. */
function commitUploadedFile({ ownerId, parentId, name, mime, size, tempPath }){
  const nodes = loadNodes();
  if(parentId){
    assertOwned(nodes.find(n => n.id === parentId), ownerId);
  }
  const id = crypto.randomUUID();
  const destPath = path.join(userDir(ownerId), id);
  fs.renameSync(tempPath, destPath);

  const node = {
    id, ownerId, parentId: parentId || null,
    type: 'file', name: validateName(name),
    size, mime: mime || 'application/octet-stream',
    createdAt: Date.now()
  };
  nodes.push(node);
  saveNodes(nodes);
  return node;
}

function filePathOnDisk(node){
  return path.join(userDir(node.ownerId), node.id);
}

function renameNode(id, ownerId, newName){
  const nodes = loadNodes();
  const node = assertOwned(nodes.find(n => n.id === id), ownerId);
  node.name = validateName(newName);
  saveNodes(nodes);
  return node;
}

function deleteNodeCascade(id, ownerId){
  const nodes = loadNodes();
  const node = assertOwned(nodes.find(n => n.id === id), ownerId);
  const toDelete = [node];
  const queue = [node.id];
  while(queue.length){
    const pid = queue.shift();
    for(const n of nodes){
      if(n.parentId === pid){
        toDelete.push(n);
        queue.push(n.id);
      }
    }
  }
  const idsToDelete = new Set(toDelete.map(n => n.id));
  for(const n of toDelete){
    if(n.type === 'file'){
      const p = filePathOnDisk(n);
      fs.rm(p, { force:true }, () => {});
    }
  }
  const remaining = nodes.filter(n => !idsToDelete.has(n.id));
  saveNodes(remaining);
}

const MAX_SEARCH_RESULTS = 50;

/**
 * Case-insensitive substring search over every folder/file the user owns,
 * anywhere in their drive (not just the current folder). Each match comes
 * back with `path`: the chain of ancestor folders (root-first, as
 * {id,name} pairs, not including the match itself) so the client can jump
 * straight to it and rebuild a correct breadcrumb.
 */
function searchNodes(ownerId, query){
  const q = (query || '').trim().toLowerCase();
  if(!q) return [];

  const all = loadNodes().filter(n => n.ownerId === ownerId);
  const byId = new Map(all.map(n => [n.id, n]));

  function ancestorChain(node){
    const chain = [];
    let p = node.parentId;
    const seen = new Set(); // guard against any accidental cycle
    while(p && !seen.has(p)){
      seen.add(p);
      const parent = byId.get(p);
      if(!parent) break;
      chain.unshift({ id: parent.id, name: parent.name });
      p = parent.parentId;
    }
    return chain;
  }

  return all
    .filter(n => n.name.toLowerCase().includes(q))
    .sort((a,b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(n => ({ ...n, path: ancestorChain(n) }));
}

module.exports = {
  loadNodes, getNode, listChildren, createFolder, usageBytes,
  commitUploadedFile, filePathOnDisk, renameNode, deleteNodeCascade,
  searchNodes, assertOwned, newTempPath, validateName
};
