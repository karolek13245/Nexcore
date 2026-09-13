const Api = {
  async signup(email, password){
    return this._json('/api/auth/signup', { method:'POST', body:{ email, password } });
  },
  async login(email, password){
    return this._json('/api/auth/login', { method:'POST', body:{ email, password } });
  },
  async logout(){
    return this._json('/api/auth/logout', { method:'POST' });
  },
  async me(){
    return this._json('/api/auth/me', { method:'GET' });
  },
  async listFiles(parentId){
    const q = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '?parentId=';
    return this._json('/api/files' + q, { method:'GET' });
  },
  async search(query){
    return this._json('/api/files/search?q=' + encodeURIComponent(query), { method:'GET' });
  },
  async createFolder(name, parentId){
    return this._json('/api/files/folder', { method:'POST', body:{ name, parentId: parentId || null } });
  },
  async rename(id, name){
    return this._json(`/api/files/${id}`, { method:'PATCH', body:{ name } });
  },
  async remove(id){
    return this._json(`/api/files/${id}`, { method:'DELETE' });
  },
  async usage(){
    return this._json('/api/storage/usage', { method:'GET' });
  },
  downloadUrl(id){
    return `/api/files/download/${id}`;
  },
  viewUrl(id){
    return `/api/files/view/${id}`;
  },
  /**
   * Uploads a raw File/Blob with progress reporting.
   * onProgress(fractionComplete 0..1) is called as the browser reports
   * upload progress via XHR (fetch doesn't expose upload progress).
   */
  uploadFile(file, parentId, onProgress){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const q = new URLSearchParams({
        parentId: parentId || '',
        name: file.name,
        mime: file.type || 'application/octet-stream'
      });
      xhr.open('POST', '/api/files/upload?' + q.toString());
      xhr.upload.onprogress = (e) => {
        if(onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body;
        try{ body = JSON.parse(xhr.responseText); } catch(e){ body = { error: 'Unexpected server response.' }; }
        if(xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(body.error || `Upload failed (${xhr.status}).`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('Network error during upload.', 0));
      xhr.send(file);
    });
  },

  async _json(path, { method='GET', body } = {}){
    const opts = { method, headers:{}, credentials:'same-origin' };
    if(body !== undefined){
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try{
      res = await fetch(path, opts);
    }catch(e){
      throw new ApiError('Could not reach the server. Is it running?', 0);
    }
    let data;
    try{ data = await res.json(); } catch(e){ data = {}; }
    if(!res.ok){
      throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
    }
    return data;
  }
};

class ApiError extends Error {
  constructor(message, status){
    super(message);
    this.status = status;
  }
}
