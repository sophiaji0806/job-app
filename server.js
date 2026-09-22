const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STORE_DIR = path.join(ROOT, 'data', 'store');
const OPPORTUNITIES_DIR = path.join(ROOT, '..', '机会汇总'); // 与素材同级的岗位素材文件夹

app.use(cors());
app.use(express.json({ limit: '30mb' })); // PDF base64 体积约为原文件的 1.33 倍
app.use(express.static(PUBLIC_DIR));

// ---------- utils ----------
function ensureDir(d){ if(!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); }
ensureDir(STORE_DIR);
ensureDir(path.join(ROOT, 'data', 'seed'));

/* ============================================================
   本机 API 令牌 —— 防止浏览器里任何一个网页白嫖本服务
   没有它，恶意页面可以直接 POST /api/ai/chat 花你的 DeepSeek 余额，
   或 GET /api/store/material 拿走全部经历。
   ============================================================ */
const TOKEN_PATH = path.join(ROOT, 'data', 'token.txt');
function loadToken(){
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if(t.length >= 32) return t;
  } catch(e){}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, t, 'utf8');
  return t;
}
const API_TOKEN = loadToken();

function tokenEqual(given){
  if(typeof given !== 'string' || given.length !== API_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(API_TOKEN)); } catch(e){ return false; }
}
// 判断请求是否来自「本机同源页面」或「浏览器扩展」，跨站页面一律拒绝
function originAllowed(req){
  // 浏览器扩展：Origin 为 chrome-extension://，网页无法伪造
  if(/^chrome-extension:\/\//i.test(req.get('Origin') || '')) return true;
  if(req.get('Sec-Fetch-Site') === 'cross-site') return false;
  const o = req.get('Origin');
  if(o && /^https?:/i.test(o)){
    try {
      if(new URL(o).host.toLowerCase() !== String(req.get('Host')||'').toLowerCase()) return false;
    } catch(e){ return false; }
  }
  return true;
}
app.use('/api', (req,res,next)=>{
  // 令牌本身只发给同源页面 / 扩展，跨站拿不到，等于拿不到钥匙
  if(req.path === '/token' && req.method === 'GET'){
    if(!originAllowed(req)) return res.status(403).json({ error:'拒绝跨站读取令牌' });
    return res.json({ token: API_TOKEN });
  }
  const given = req.get('X-JobApp-Token') || (req.query && req.query.token) || '';
  if(!tokenEqual(given)){
    return res.status(401).json({ error:'缺少或错误的 X-JobApp-Token。请刷新工作台页面；若仍失败，删除 data/token.txt 后重启服务。' });
  }
  next();
});

function readJson(p, fallback){
  try { const t = fs.readFileSync(p, 'utf8'); return t.trim() ? JSON.parse(t) : fallback; }
  catch(e){ return fallback; }
}
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }

// Excel 序列日期转 YYYY-MM-DD（1900 坐标系）
function excelSerialToDate(serial){
  if(typeof serial !== 'number' || !isFinite(serial)) return null;
  // 处理 1900 闰年 bug: 序列 60 为 1900-02-29（虚拟）
  let s = serial;
  const epoch = new Date(Date.UTC(1899,11,30));
  const d = new Date(epoch.getTime() + s * 86400 * 1000);
  if (isNaN(d.getTime())) return null;
  if (s === 60) return null;
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,'0'), dd = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function normalizeDate(v){
  if (v == null || v === '') return '';
  if (typeof v === 'number') return excelSerialToDate(v) || String(v);
  const s = String(v).trim();
  if (/^\d{4,5}$/.test(s)) return excelSerialToDate(Number(s)) || s; // 纯数字可能为序列
  // 已是日期字符串或文字（尽快投递 / 招满即止）
  const m = s.match(/^(\d{4})[/-]?(\d{1,2})[/-]?(\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s;
}

// ---------- config (DeepSeek) ----------
function getConfig(){
  return readJson(CONFIG_PATH, { apiKey:'', baseUrl:'https://api.deepseek.com', model:'deepseek-chat' });
}
app.get('/api/config', (req,res)=>{
  const c = getConfig();
  // 不泄漏完整 key，仅返回是否已配置 + 掩码
  const key = c.apiKey || '';
  const masked = key.length>8 ? key.slice(0,4)+'…'+key.slice(-4) : (key ? '已配置' : '');
  res.json({ baseUrl:c.baseUrl, model:c.model, hasKey: !!key, keyMasked:masked });
});
app.post('/api/config', (req,res)=>{
  const body = req.body || {};
  const c = getConfig();
  if(body.apiKey !== undefined) c.apiKey = String(body.apiKey).trim();
  if(body.baseUrl) c.baseUrl = String(body.baseUrl).trim();
  if(body.model) c.model = String(body.model).trim();
  writeJson(CONFIG_PATH, c);
  res.json({ ok:true });
});

// ---------- AI proxy (OpenAI-compatible, 默认 DeepSeek) ----------
// 抽出来给多处复用（/api/ai/chat、/api/apply/answer）
async function callAI(messages, opts){
  opts = opts || {};
  const cfg = getConfig();
  if(!cfg.apiKey) throw new Error('未配置 API Key。请在【设置】填入 DeepSeek(或任意 OpenAI 兼容) Key。');
  const payload = {
    model: cfg.model,
    messages: opts.system ? [{role:'system', content:opts.system}, ...messages] : messages,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
    stream: false
  };
  const r = await fetch(cfg.baseUrl.replace(/\/$/,'') + '/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+cfg.apiKey },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok){
    const msg = data && data.error ? data.error.message : ('HTTP '+r.status);
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return (data && data.choices && data.choices[0] && data.choices[0].message)
    ? String(data.choices[0].message.content || '') : '';
}

app.post('/api/ai/chat', async (req,res)=>{
  const { messages=[], temperature=0.3, system } = req.body || {};
  try {
    const content = await callAI(messages, { temperature, system });
    res.json({ content });
  } catch(e){
    res.status(e.status || 500).json({ error: e.status ? e.message : ('请求失败: '+e.message) });
  }
});

// ---------- store：通用 JSON 持久化 ----------
const RESOURCES = ['material','knowledge','jobs','resumes','interview','tracker','career','recs','cv','apply'];
function storePath(resource){
  if(!RESOURCES.includes(resource)) return null;
  const p = path.join(STORE_DIR, resource + '.json');
  if(!fs.existsSync(p)) writeJson(p, []);
  return p;
}
app.get('/api/store/:resource', (req,res)=>{
  const p = storePath(req.params.resource);
  if(!p) return res.status(400).json({error:'unknown resource'});
  res.json(readJson(p, []));
});
app.put('/api/store/:resource', (req,res)=>{
  const p = storePath(req.params.resource);
  if(!p) return res.status(400).json({error:'unknown resource'});
  // apply 存的是对象 { profile, answers, history }，其余资源都是数组
  const isObj = req.params.resource === 'apply';
  if(!isObj && !Array.isArray(req.body)) return res.status(400).json({error:'body must be array'});
  if(isObj && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({error:'apply 需要对象 { profile, answers, history }'});
  writeJson(p, req.body);
  res.json({ok:true, count: isObj ? Object.keys(req.body).length : req.body.length});
});
app.post('/api/store/:resource/item', (req,res)=>{
  const p = storePath(req.params.resource);
  if(!p) return res.status(400).json({error:'unknown resource'});
  const arr = readJson(p, []);
  const item = req.body;
  if(!item.id) item.id = (require('crypto').randomUUID());
  arr.push(item);
  writeJson(p, arr);
  res.json({ok:true, item});
});
app.put('/api/store/:resource/item/:id', (req,res)=>{
  const p = storePath(req.params.resource);
  if(!p) return res.status(400).json({error:'unknown resource'});
  const arr = readJson(p, []);
  const i = arr.findIndex(x => x.id === req.params.id);
  if(i === -1) return res.status(404).json({error:'not found'});
  arr[i] = { ...arr[i], ...req.body, id:req.params.id };
  writeJson(p, arr);
  res.json({ok:true, item:arr[i]});
});
app.delete('/api/store/:resource/item/:id', (req,res)=>{
  const p = storePath(req.params.resource);
  if(!p) return res.status(400).json({error:'unknown resource'});
  const arr = readJson(p, []);
  const i = arr.findIndex(x => x.id === req.params.id);
  if(i === -1) return res.status(404).json({error:'not found'});
  arr.splice(i,1);
  writeJson(p, arr);
  res.json({ok:true});
});

// ---------- seed：从 data/seed 读取首版种子（store 为空时前端会拉取） ----------
const SEEDABLE = ['material','career','recs','jobs','resumes','interview','tracker'];
app.get('/api/seed/:name', (req,res)=>{
  const name = req.params.name;
  if(!SEEDABLE.includes(name) || name.includes('..')) return res.status(400).json({error:'bad seed name'});
  const p = path.join(ROOT, 'data', 'seed', name + '.json');
  if(!fs.existsSync(p)) return res.json([]);
  res.json(readJson(p, []));
});

// ---------- 机会 Excel 一键更新 ----------
function readJobExcel(filePath){
  const wb = XLSX.readFile(filePath);
  const rows = [];
  for(const sheetName of wb.SheetNames){
    const sheet = wb.Sheets[sheetName];
    if(!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, raw:false});
    // 找表头行（含 公司名称 或 公司）
    let hi = -1;
    for(let i=0;i<aoa.length;i++){
      const h = (aoa[i]||[]).map(x=>String(x||'').trim());
      if(h.some(x=>x==='公司名称'||x==='公司')){ hi=i; break; }
    }
    if(hi === -1) continue;
    const header = (aoa[hi]||[]).map(x=>String(x||'').trim());
    const idx = {
      date: header.indexOf('更新日期'),
      company: header.findIndex(h=>h==='公司名称'||h==='公司'),
      industry: header.indexOf('行业'),
      type: header.indexOf('类型'),
      title: header.indexOf('公告详情') !== -1 ? header.indexOf('公告详情') : header.indexOf('岗位'),
      location: header.indexOf('地点'),
      apply: header.indexOf('报名方式'),
      deadline: header.indexOf('截至日期') !== -1 ? header.indexOf('截至日期') : header.indexOf('截止日期')
    };
    for(let r=hi+1;r<aoa.length;r++){
      const row = aoa[r]||[];
      const get = (i)=> i>=0 ? (row[i]!=null?String(row[i]).trim():'') : '';
      const company = get(idx.company);
      const title = get(idx.title);
      if(!company && !title) continue;
      // 提取报名方式列的超链接（岗位可跳转的招聘网站）
      let applyUrl = '';
      if(idx.apply >= 0){
        const addr = XLSX.utils.encode_cell({ r:r+1, c:idx.apply });
        const cell = sheet[addr];
        if(cell && cell.l && cell.l.Target) applyUrl = cell.l.Target;
      }
      rows.push({
        id: `${company}|${title}|${get(idx.location)}|${r}`,
        company, title,
        industry: get(idx.industry),
        workType: get(idx.type),
        location: get(idx.location),
        applyMethod: get(idx.apply),
        applyUrl,
        updatedAt: normalizeDate(get(idx.date)),
        deadline: normalizeDate(get(idx.deadline)),
        source: '本地Excel'
      });
    }
  }
  return rows;
}

app.post('/api/jobs/import-excel', (req,res)=>{
  // 1) 优先按路径直接读本地「机会汇总」文件夹
  let files = [];
  try { files = fs.readdirSync(OPPORTUNITIES_DIR).filter(f=>/\.xlsx?$/i.test(f) && !f.startsWith('~$')); } catch(e){}
  let rows = [];
  if(files.length){
    for(const f of files){
      try { rows = rows.concat(readJobExcel(path.join(OPPORTUNITIES_DIR, f))); } catch(e){ console.error('读 excel 失败', f, e.message); }
    }
  }
  // 2) 否则用请求体里 base64 上传的文件（浏览器 <input type=file>）
  if(!rows.length && req.body && req.body.fileBase64){
    const buf = Buffer.from(req.body.fileBase64, 'base64');
    const wb = XLSX.read(buf, {type:'buffer'});
    for(const sheetName of wb.SheetNames){
      const sheet = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, raw:false});
      let hi = aoa.findIndex(r=>(r||[]).some(x=>['公司名称','公司'].includes(String(x).trim())));
      if(hi === -1) continue;
      const header = (aoa[hi]||[]).map(x=>String(x||'').trim());
      const idx = { date:header.indexOf('更新日期'), company:header.findIndex(h=>['公司名称','公司'].includes(h)), industry:header.indexOf('行业'), type:header.indexOf('类型'), title:header.indexOf('公告详情')!==-1?header.indexOf('公告详情'):header.indexOf('岗位'), location:header.indexOf('地点'), apply:header.indexOf('报名方式'), deadline:header.indexOf('截至日期')!==-1?header.indexOf('截至日期'):header.indexOf('截止日期') };
      for(let r=hi+1;r<aoa.length;r++){
        const row = aoa[r]||[]; const get=i=>i>=0?(row[i]!=null?String(row[i]).trim():''):'';
        const company=get(idx.company), title=get(idx.title);
        if(!company&&!title) continue;
        let applyUrl='';
        if(idx.apply>=0){ const addr=XLSX.utils.encode_cell({r:r+1,c:idx.apply}); const cell=sheet[addr]; if(cell&&cell.l&&cell.l.Target) applyUrl=cell.l.Target; }
        rows.push({ id:`${company}|${title}|${get(idx.location)}|${r}`, company, title, industry:get(idx.industry), workType:get(idx.type), location:get(idx.location), applyMethod:get(idx.apply), applyUrl, updatedAt:normalizeDate(get(idx.date)), deadline:normalizeDate(get(idx.deadline)), source:req.body.source||'上传Excel' });
      }
    }
  }
  if(!rows.length) return res.status(404).json({error:'未找到本地「机会汇总」Excel 且未上传文件', rows});
  writeJson(storePath('jobs'), rows);
  res.json({ok:true, count:rows.length, rows});
});

// ---------- 简历 PDF 导入（提取文本，供面试练习等复用） ----------
function extractPdfText(buf){
  const tmp = path.join(os.tmpdir(), 'resume_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  const script = path.join(__dirname, 'pdf_extract.py');
  try {
    for(const py of ['python','py','python3']){
      try {
        return execFileSync(py, [script, tmp], { encoding:'utf8', maxBuffer: 20*1024*1024, windowsHide:true, cwd:__dirname });
      } catch(e){ /* 试下一个解释器 */ }
    }
    throw new Error('未找到可用 Python（需安装 pymupdf）。请运行: pip install pymupdf');
  } finally {
    try { fs.unlinkSync(tmp); } catch(e){}
  }
}
app.post('/api/resumes/import-pdf', (req,res)=>{
  const { fileBase64, filename } = req.body || {};
  if(!fileBase64) return res.status(400).json({error:'缺少文件内容'});
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    if(buf.length > 20*1024*1024) return res.status(400).json({error:'文件过大（>20MB），请压缩后重试'});
    const text = extractPdfText(buf);
    if(!text || !text.trim()) return res.status(422).json({error:'未能从 PDF 提取文字。若为图片扫描件，请先 OCR 后再导入。'});
    res.json({ ok:true, text, filename: filename || '' });
  } catch(e){
    res.status(500).json({ error:'PDF 解析失败：' + e.message });
  }
});

// ---------- 简历排版 → 真 PDF（调用本机 Chrome/Edge 无头打印） ----------
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
function findBrowser(){
  for(const p of CHROME_PATHS){ try { if(fs.existsSync(p)) return p; } catch(e){} }
  return null;
}
app.get('/api/resumes/pdf-engine', (req,res)=>{
  const b = findBrowser();
  res.json({ ok: !!b, engine: b ? path.basename(b) : '' });
});
app.post('/api/resumes/render-pdf', (req,res)=>{
  const html = (req.body && req.body.html) || '';
  if(!html || html.length < 50) return res.status(400).json({ error:'缺少 HTML 内容' });
  const exe = findBrowser();
  if(!exe) return res.status(500).json({ error:'未找到 Chrome / Edge，无法导出 PDF。请安装 Chrome 或 Edge 后重启服务。' });
  const tmpDir = path.join(ROOT, 'data', 'tmp');
  ensureDir(tmpDir);
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const inFile = path.join(tmpDir, 'cv_' + stamp + '.html');
  const outFile = path.join(tmpDir, 'cv_' + stamp + '.pdf');
  const udDir = path.join(tmpDir, 'ud_' + stamp);
  try {
    fs.writeFileSync(inFile, html, 'utf8');
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
      '--no-pdf-header-footer', '--print-to-pdf-no-header',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=8000',
      '--user-data-dir=' + udDir,
      '--print-to-pdf=' + outFile,
      'file:///' + inFile.replace(/\\/g,'/').replace(/^\/+/,'')
    ];
    execFileSync(exe, args, { encoding:'utf8', timeout: 60000, windowsHide:true, stdio:'ignore' });
    if(!fs.existsSync(outFile)) return res.status(500).json({ error:'浏览器没有生成 PDF 文件（可能页面渲染超时）' });
    const buf = fs.readFileSync(outFile);
    if(!buf.length) return res.status(500).json({ error:'生成的 PDF 为空' });
    res.json({ ok:true, bytes: buf.length, pdfBase64: buf.toString('base64') });
  } catch(e){
    res.status(500).json({ error:'PDF 导出失败：' + (e.message || e) });
  } finally {
    for(const f of [inFile, outFile]) { try { fs.unlinkSync(f); } catch(e){} }
    try { fs.rmSync(udDir, { recursive:true, force:true }); } catch(e){}
  }
});

// ---------- 知识库配图上传（存 data/uploads，返回可嵌入 Markdown 的 URL） ----------
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
ensureDir(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));
const IMG_EXT = ['png','jpg','jpeg','gif','webp','svg','bmp'];
app.post('/api/uploads', (req,res)=>{
  const { filename, fileBase64 } = req.body || {};
  if(!fileBase64) return res.status(400).json({error:'缺少文件内容'});
  const m = String(filename||'').match(/\.([A-Za-z0-9]{1,6})$/);
  const ext = m ? m[1].toLowerCase() : 'png';
  if(!IMG_EXT.includes(ext)) return res.status(400).json({error:'只支持图片：'+IMG_EXT.join(' / ')});
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    if(!buf.length) return res.status(400).json({error:'图片内容为空'});
    if(buf.length > 8*1024*1024) return res.status(400).json({error:'图片过大（>8MB），请压缩后重试'});
    const name = 'kb_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ ok:true, url:'/uploads/'+name, name });
  } catch(e){
    res.status(500).json({ error:'图片保存失败：'+e.message });
  }
});

// ---------- 抓取 JD（尽力而为，失败提示改粘贴） ----------
app.post('/api/jobs/fetch-jd', async (req,res)=>{
  const url = (req.body&&req.body.url||'').trim();
  if(!url) return res.status(400).json({error:'缺少 URL'});
  try {
    const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0' }, redirect:'follow' });
    const html = await r.text();
    // 粗暴去 html
    const txt = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    res.json({ ok:true, text: txt.slice(0, 15000), url });
  } catch(e){
    res.status(200).json({ ok:false, error:'自动抓取失败：'+e.message+'（请改用【粘贴JD】）' });
  }
});

/* ============================================================
   网申问答生成 —— 扩展把网申里答不上来的长问题发过来，
   服务端按 JD 从经历库里挑出最相关的几条事实，交给 AI 写答案。
   原则：只用经历库里已有的数字和表述，不许编。
   ============================================================ */
const APPLY_PATH = path.join(STORE_DIR, 'apply.json');
const MATERIAL_PATH = path.join(STORE_DIR, 'material.json');
const RESUMES_PATH = path.join(STORE_DIR, 'resumes.json');

// 问题指纹：同一道题（换个大小写、多个星号）视为同一条，可复用已存答案
function qnorm(s){
  return String(s || '').toLowerCase().replace(/[\s　]+/g, ' ')
    .replace(/[*＊:：?？.。,，!！;；"'（）()\[\]]+/g, '').trim();
}

function scoreMaterial(m, hay){
  let s = 0;
  for (const k of (m.kw || [])) if (k && hay.indexOf(String(k).toLowerCase()) >= 0) s += 3;
  for (const d of (m.dirs || [])) if (d && hay.indexOf(String(d).toLowerCase()) >= 0) s += 2;
  return s;
}

// 从每条经历的多个方向写法里，挑跟这道题/JD 最贴的一版
function pickBullet(m, hay){
  const bs = m.bullets || [];
  if (!bs.length) return null;
  const byDir = bs.find(b => b.dir && hay.indexOf(String(b.dir).toLowerCase()) >= 0);
  const general = bs.find(b => b.dir === '通用');
  return byDir || general || bs[0];
}

function evidenceBlock(jd, question, company, title, limit){
  const all = readJson(MATERIAL_PATH, []);
  const hay = (jd + ' ' + question + ' ' + company + ' ' + title).toLowerCase();
  const ranked = all
    .map(m => ({ m, s: scoreMaterial(m, hay) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.m);
  const lines = [];
  ranked.forEach((m, i) => {
    const b = pickBullet(m, hay);
    lines.push('[' + (i + 1) + '] ' + (m.title || '') + (m.phase ? '（' + m.phase + '）' : ''));
    if (m.metrics && m.metrics.length) lines.push('    量化：' + m.metrics.join(' / '));
    if (b && b.desc) lines.push('    表述：' + b.desc);
  });
  return { text: lines.join('\n'), used: ranked.map(m => m.title || '') };
}

// 中英文的「长度」单位不一样：中文按汉字数，英文按单词数。用同一个数字下指令，英文必然超标。
function budget(lang, maxLength, angle){
  const defCap = lang === 'en' ? 900 : 320;
  const cap = maxLength ? Math.max(80, Math.min(maxLength, 1200)) : defCap;
  let target = lang === 'en' ? Math.min(cap, 700) : Math.min(cap, 260);
  if (angle === 'concise') target = Math.round(target * 0.6);
  target = Math.max(80, Math.min(target, cap));
  return { cap, target, lo: Math.round(target * 0.8) };
}

function applyAnswerPrompt(o){
  const langName = o.lang === 'en' ? '英文（地道商务英文）' : o.lang === 'tw' ? '繁體中文' : '简体中文';
  const { cap, target, lo } = budget(o.lang, o.maxLength, o.angle);
  const lenLine = o.lang === 'en'
    ? '- 长度：' + Math.round(lo / 6) + '-' + Math.round(target / 6) + ' 个英文单词，'
      + '即总字符数不超过 ' + cap + '（表单会按字符截断）'
    : '- 长度：' + lo + '-' + target + ' 个字，硬上限 ' + cap + ' 字（表单会按字符截断）';
  const angleNote = o.angle === 'concise' ? '\n- 尽量短，删掉一切修饰，只留最硬的 1 个事实'
    : o.angle === 'different' ? '\n- 换一个角度：不要用「我做过 X」开场，改从业务问题或结果切入'
      : '';

  return {
    cap,
    system: '你是资深求职顾问，为候选人撰写网申问答。铁律：只能使用【候选人事实】里出现过的事实、数字和项目名称，'
      + '一个字都不许编造。宁可少写一个数字，也不能编一个。严格遵守字数上限。',
    user: [
      '【候选人事实】（唯一可用的素材，按与本题的相关度排序）',
      o.evidence || '（经历库为空，请只使用下面的基础简历）',
      '',
      '【基础简历】',
      o.base || '（无）',
      '',
      '【目标岗位】' + (o.company || '（未填公司）') + (o.title ? ' · ' + o.title : ''),
      o.jd ? '\n【岗位 JD】\n' + String(o.jd).slice(0, 6000) : '',
      '',
      '【要回答的问题】' + o.question,
      '',
      '【写作要求】',
      '- 语言：' + langName,
      lenLine,
      '- 第一人称，直接输出答案本身：不要复述问题、不要加标题、不要引号、不要"答案："这类前缀',
      '- 结构：一句立场或结论 → 1-2 个带数字的具体事实 → 一句和这个岗位的连接' + angleNote,
      '- 禁止空话（"贵公司平台广阔""我学习能力强""贵司行业领先"这类一律不要）',
      '- 用词具体：写清是什么业务、什么方法、什么结果'
    ].join('\n')
  };
}

// 超长就再让 AI 压一次，而不是硬截断（截断会把句子砍半个）
const SHRINK_SYS = '你是资深编辑。把给定答案压缩到指定字符数以内：保留事实与数字，删掉一切修饰、铺垫和重复，'
  + '不要新增任何内容，不要改写事实。只输出压缩后的正文。';
function shrinkPrompt(prev, cap, lang){
  return '下面这段答案有 ' + prev.length + ' 个字符，超过上限 ' + cap + ' 个字符。\n'
    + '请压缩到 ' + cap + ' 个字符以内（' + (lang === 'en' ? '约 ' + Math.floor(cap / 6) + ' 个英文单词' : '约 ' + cap + ' 个汉字') + '），'
    + '保留最硬的 1-2 个带数字的事实，删掉所有修饰。只输出正文。\n\n'
    + '---\n' + prev + '\n---';
}

app.post('/api/apply/answer', async (req,res)=>{
  const b = req.body || {};
  const question = String(b.question || '').trim();
  if (!question) return res.status(400).json({ error:'缺少问题原文' });

  const applyDoc = readJson(APPLY_PATH, { profile:{}, answers:{}, history:[] });
  const key = qnorm(question);

  // 1) 档案里已经存过这道题 —— 直接用，不花 token
  if (!b.force && !b.angle && applyDoc.answers && applyDoc.answers[key]) {
    const hit = applyDoc.answers[key];
    return res.json({ ok:true, answer: hit.a, chars: hit.a.length, cached: true, used: hit.used || [] });
  }

  // 2) 组装证据
  const lang = b.lang || 'zh';
  const resumes = readJson(RESUMES_PATH, []);
  const baseRes = resumes.find(r => r.type === 'base' && r.kind === lang)
    || resumes.find(r => r.type === 'base');
  const ev = evidenceBlock(String(b.jd || ''), question, String(b.company || ''), String(b.title || ''), 6);

  const p = applyAnswerPrompt({
    question, lang,
    maxLength: b.maxLength,
    angle: b.angle,
    company: b.company, title: b.title, jd: b.jd,
    evidence: ev.text,
    base: baseRes ? String(baseRes.content || '').slice(0, 3000) : ''
  });

  try {
    let answer = (await callAI([{ role:'user', content:p.user }], { system:p.system, temperature:0.5 })).trim();
    if (!answer) return res.status(500).json({ error:'AI 返回了空答案，请重试' });

    let shrunk = false;
    if (answer.length > p.cap) {
      try {
        const shorter = (await callAI([{ role:'user', content: shrinkPrompt(answer, p.cap, lang) }],
          { system: SHRINK_SYS, temperature:0.2 })).trim();
        if (shorter && shorter.length < answer.length) { answer = shorter; shrunk = true; }
      } catch(e){ /* 压缩失败就保留原答案，交给用户自己删 */ }
    }
    res.json({
      ok:true, answer, chars: answer.length, cap: p.cap, shrunk,
      over: answer.length > p.cap,
      used: ev.used, base: baseRes ? baseRes.title : ''
    });
  } catch(e){
    res.status(e.status || 500).json({ error: e.status ? e.message : ('生成失败：' + e.message) });
  }
});

// 存成「现成答案」，下次遇到同一道题直接复用
app.post('/api/apply/save-answer', (req,res)=>{
  const b = req.body || {};
  const question = String(b.question || '').trim();
  const answer = String(b.answer || '').trim();
  if (!question || !answer) return res.status(400).json({ error:'缺少问题或答案' });
  const d = readJson(APPLY_PATH, { profile:{}, answers:{}, history:[] });
  if (!d.answers) d.answers = {};
  d.answers[qnorm(question)] = { q: question, a: answer, used: b.used || [], ts: new Date().toISOString().slice(0,16).replace('T',' ') };
  writeJson(APPLY_PATH, d);
  res.json({ ok:true, count: Object.keys(d.answers).length });
});

/* ---------- 投递进度 ---------- */
const TRACKER_PATH = path.join(STORE_DIR, 'tracker.json');
const TRACKER_STATUSES = ['待投递','已投递','笔试','面试','Offer','已拒','已关闭'];
const TRACKER_DEFAULT = '待投递';

function hostOf(url){
  try { return new URL(String(url)).host.toLowerCase().replace(/^www\./,''); } catch(e){ return ''; }
}
function trackerKey(t){
  const u = String(t.url || '').split('#')[0].replace(/\/$/,'');
  if (u) return 'u:' + u;
  return 'c:' + qnorm(t.company) + '|' + qnorm(t.title);
}
// 同一个岗位重复填表就更新那一条，不新增重复行
function trackerUpsert(patch){
  const list = readJson(TRACKER_PATH, []);
  const rows = Array.isArray(list) ? list : [];
  const now = new Date().toISOString().slice(0,16).replace('T',' ');
  const inc = {
    company: String(patch.company || '').slice(0,120),
    title: String(patch.title || '').slice(0,120),
    url: String(patch.url || '').slice(0,500),
    site: hostOf(patch.url)
  };
  if (patch.filled != null) inc.filled = patch.filled;
  if (patch.jd) inc.jd = String(patch.jd).slice(0, 8000);
  if (patch.deadline) inc.deadline = String(patch.deadline).slice(0, 40);
  if (patch.notes) inc.notes = String(patch.notes).slice(0, 2000);
  if (Array.isArray(patch.questions) && patch.questions.length) inc.questions = patch.questions.slice(0,50);

  const key = trackerKey({ url: inc.url, company: inc.company, title: inc.title });
  let row = rows.find(r => trackerKey(r) === key);
  if (!row) {
    row = {
      id: 'tk-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      company: inc.company, title: inc.title, url: inc.url, site: inc.site,
      status: TRACKER_DEFAULT, deadline: '', notes: '', jd: '', questions: [], filled: null,
      jobId: patch.jobId || '',
      createdAt: now, updatedAt: now, submittedAt: '', events: []
    };
    rows.unshift(row);
  }
  for (const k of ['company','title','url','site','filled','jd','questions','deadline','notes','jobId']) {
    if (inc[k] !== undefined && inc[k] !== '' && inc[k] !== null) row[k] = inc[k];
  }
  row.updatedAt = now;
  if (patch.status && TRACKER_STATUSES.indexOf(patch.status) >= 0 && patch.status !== row.status) {
    if (row.status !== patch.status) row.events.push({ ts: now, from: row.status, to: patch.status });
    row.status = patch.status;
    if (patch.status === '已投递' && !row.submittedAt) row.submittedAt = now;
  }
  if (patch.note) row.events.push({ ts: now, text: String(patch.note).slice(0,300) });
  writeJson(TRACKER_PATH, rows);
  return { row, rows };
}

// 记录一次网申（扩展「填入页面」时自动调，status=待投递；点「记一笔投递」则升为已投递）
app.post('/api/apply/log', (req,res)=>{
  const b = req.body || {};
  const d = readJson(APPLY_PATH, { profile:{}, answers:{}, history:[] });
  if (!d.history) d.history = [];
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  const item = {
    id: 'ap-' + Date.now(),
    ts,
    url: String(b.url || '').slice(0, 500),
    company: String(b.company || '').slice(0, 120),
    title: String(b.title || '').slice(0, 120),
    filled: b.filled != null ? b.filled : null,
    questions: Array.isArray(b.questions) ? b.questions.slice(0, 50) : []
  };
  d.history.push(item);
  if (d.history.length > 500) d.history = d.history.slice(-500);
  writeJson(APPLY_PATH, d);

  const status = TRACKER_STATUSES.indexOf(b.status) >= 0 ? b.status : null;
  const { row } = trackerUpsert({ ...item, jd: b.jd, status, note: b.note });
  res.json({ ok:true, id: item.id, count: d.history.length, trackerId: row.id, status: row.status });
});

// 手动新增 / 修改一条投递记录
app.post('/api/tracker/add', (req,res)=>{
  const b = req.body || {};
  if (!b.company && !b.title && !b.url) return res.status(400).json({ error:'至少要填公司、岗位或链接' });
  const { row } = trackerUpsert(b);
  res.json({ ok:true, row });
});

app.put('/api/tracker/item/:id', (req,res)=>{
  const rows = readJson(TRACKER_PATH, []);
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find(r => r.id === req.params.id);
  if (!row) return res.status(404).json({ error:'没有这条投递记录' });
  const b = req.body || {};
  const now = new Date().toISOString().slice(0,16).replace('T',' ');
  if (b.status !== undefined) {
    if (TRACKER_STATUSES.indexOf(b.status) < 0) return res.status(400).json({ error:'状态只能是：' + TRACKER_STATUSES.join(' / ') });
    if (b.status !== row.status) {
      row.events = row.events || [];
      row.events.push({ ts: now, from: row.status, to: b.status });
      row.status = b.status;
      if (b.status === '已投递' && !row.submittedAt) row.submittedAt = now;
    }
  }
  for (const k of ['company','title','url','deadline','notes','jd','jobId']) {
    if (b[k] !== undefined) row[k] = String(b[k]).slice(0, 8000);
  }
  if (Array.isArray(b.questions)) row.questions = b.questions.slice(0,50);
  if (b.url !== undefined) row.site = hostOf(b.url);
  row.updatedAt = now;
  writeJson(TRACKER_PATH, list);
  res.json({ ok:true, row });
});

// ---------- 静态入口 ----------
app.get('/', (req,res)=> res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// ---------- /api 兜底：永远返回 JSON，不返回 HTML（否则前端 r.json() 报 Unexpected token '<'） ----------
app.use('/api', (req,res)=> res.status(404).json({ error:'未知接口 '+req.method+' '+req.originalUrl+'（若服务器刚改过代码，请重启 node server.js）' }));
app.use((err, req, res, next)=>{
  if(res.headersSent) return next(err);
  const tooBig = err && (err.type === 'entity.too.large' || err.status === 413);
  const status = tooBig ? 413 : (err.status || 500);
  const msg = tooBig ? '请求体过大：PDF 需小于 20MB，请压缩后重试' : ('服务器错误：' + (err.message || err));
  console.error('[api error]', req.method, req.originalUrl, '-', msg);
  res.status(status).json({ error: msg });
});

app.listen(PORT, ()=> console.log(`\n  🛠  Job Portal 运行中 →  http://localhost:${PORT}\n`));
