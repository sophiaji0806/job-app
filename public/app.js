/* ============================================================
   纪子悦 · 求职工作台  app.js
   数据层 + 设置(DeepSeek) + Tab 导航 + 各模块渲染
   ============================================================ */
'use strict';

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

/* ---------------- 本机 API 令牌 ----------------
   服务器要求所有 /api 请求带 X-JobApp-Token。令牌只发给同源页面，
   所以浏览器里别的网站拿不到，无法借本服务花你的 DeepSeek 余额。 */
let API_TOKEN = '';
function apiFetch(url, init={}){
  const opt = Object.assign({}, init);
  opt.headers = Object.assign({}, init.headers||{});
  if(API_TOKEN) opt.headers['X-JobApp-Token'] = API_TOKEN;
  return fetch(url, opt);
}

const API = {
  token: () => fetch('/api/token').then(r=>r.json()),
  config: { get: () => apiFetch('/api/config').then(r=>r.json()),
            set: (b) => apiFetch('/api/config', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()) },
  store: {
    get: (res) => apiFetch('/api/store/'+res).then(r=>r.json()),
    put: (res, arr) => apiFetch('/api/store/'+res, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(arr)}).then(r=>r.json()),
    add: (res, item) => apiFetch('/api/store/'+res+'/item', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)}).then(r=>r.json()),
    del: (res, id) => apiFetch('/api/store/'+res+'/item/'+id, {method:'DELETE'}).then(r=>r.json())
  },
  chat: async (messages, opts={}) => {
    // AI 生成长文可能耗时 60-90 秒，给 240 秒上限并返回可读错误，避免"点了没反应"
    const ac = new AbortController();
    const timer = setTimeout(()=>ac.abort(), 240000);
    try {
      const r = await apiFetch('/api/ai/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages, ...opts}), signal: ac.signal});
      const t = await r.text();
      try { return JSON.parse(t); }
      catch(e){ return { error:'AI 接口返回非 JSON（HTTP '+r.status+'）：'+t.replace(/\s+/g,' ').slice(0,140) }; }
    } catch(e){
      return { error: e && e.name==='AbortError' ? 'AI 请求超时（>240 秒），请重试或换更短的素材' : ('AI 请求失败：'+((e&&e.message)||e)) };
    } finally { clearTimeout(timer); }
  },
  importJobs: (body) => apiFetch('/api/jobs/import-excel', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(r=>r.json()),
  fetchJd: (url) => apiFetch('/api/jobs/fetch-jd', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).then(r=>r.json()),
  importResumePdf: async (body) => {
    const r = await apiFetch('/api/resumes/import-pdf', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const t = await r.text();
    try { return JSON.parse(t); }
    catch(e){
      if(r.status===404) return { error:'后端没有 /api/resumes/import-pdf 路由——服务器跑的是旧代码，请重启（Ctrl+C 后重新 node server.js）' };
      if(r.status===413) return { error:'请求体过大（HTTP 413）。PDF 超过服务器上限，请压缩后重试。' };
      return { error:'服务器返回了非 JSON 响应（HTTP '+r.status+'）：'+t.replace(/\s+/g,' ').slice(0,140) };
    }
  },
  renderPdf: async (html) => {
    const r = await apiFetch('/api/resumes/render-pdf', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({html})});
    const t = await r.text();
    try { return JSON.parse(t); }
    catch(e){ return { error:'PDF 接口返回非 JSON（HTTP '+r.status+'）：'+t.replace(/\s+/g,' ').slice(0,140) }; }
  },
  pdfEngine: () => apiFetch('/api/resumes/pdf-engine').then(r=>r.json()).catch(()=>({ok:false})),
  uploadImage: async (body) => {
    const r = await apiFetch('/api/uploads', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const t = await r.text();
    try { return JSON.parse(t); }
    catch(e){ return { error:'上传接口返回非 JSON（HTTP '+r.status+'）' }; }
  },
  seed: { get: (name) => apiFetch('/api/seed/'+name).then(r=>r.json()) },
  apply: {
    answer: async (body) => {
      const r = await apiFetch('/api/apply/answer', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const t = await r.text();
      try { return JSON.parse(t); }
      catch(e){ return { error:'生成接口返回非 JSON（HTTP '+r.status+'）：'+t.replace(/\s+/g,' ').slice(0,140) }; }
    },
    log: (body) => apiFetch('/api/apply/log', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json())
  },
  tracker: {
    add: (item) => apiFetch('/api/tracker/add', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)}).then(r=>r.json()),
    update: (id, patch) => apiFetch('/api/tracker/item/'+encodeURIComponent(id), {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}).then(r=>r.json()),
    remove: (id) => apiFetch('/api/store/tracker/item/'+encodeURIComponent(id), {method:'DELETE'}).then(r=>r.json())
  }
};

/* ---------------- 全局 state ---------------- */
const state = {
  config: { hasKey:false, keyMasked:'', baseUrl:'', model:'' },
  resources: { material:[], knowledge:[], jobs:[], resumes:[], interview:[], tracker:[], career:[], recs:[], apply:{} },
  tab: 'material',
  pendingKbSource: null,   // 素材库 → 知识库 跳转时的传递
  resumeSub: 'jobs',       // 模块3 内子Tab
  jobFilter: { region:'all', workType:'all', q:'' },
  selectedJobId: null,
  jds: {},                 // id -> 抓取/粘贴的 JD 文本
  baseResume: { zh:null, tw:null, en:null, cover:null },
  resumeView: {},          // kind -> 'edit'|'preview'
  tailorJd: '', tailorKind: 'zh',       // 定制简历：粘贴 JD + 输出语言
  jdEntry: { jobId:'', company:'', title:'', url:'', text:'' },  // JD 工作台（独立页面）
  jdPickQ: '',                           // JD 工作台：机会库搜索词
  interviewSel: {}, interviewQa: [],    // 面试练习：当前选择 + 生成中的 Q&A
  kbQ: '', kbBusy: false,  // 知识库搜索 + 生成中标志（防重复点击 / 无反馈）
  kbDraft: null,           // 知识库：查看/编辑弹窗草稿 { id, title, content, mode }
  linkedin: null,          // LinkedIn 文案（null=用默认模板）
  applyDoc: null,          // 网申助手：{ profile, answers, history }
  cvDocs: null,            // 简历排版：{ zh|tw|en : 文档对象 }（null=用内置模板）
  cvKind: 'zh',            // 当前排版语言
  cvView: 'edit',          // 'edit' | 'preview'
  cvBusy: false,           // 导出 PDF 中
  trackerFilter: 'all',    // 投递进度：状态筛选
  trackerOpen: {},         // 投递进度：展开了哪几条（id -> true）
  trackerEdit: null        // 投递进度：正在编辑的 id
};

/* ---------------- 种子数据（首版，模块1） ---------------- */
const SEED = {
  career: [
    { id:'c-risk',     title:'信贷风控 · 金融资产减值', icon:'🛡', desc:'IRB 内部评级、PD/LGD/ECL、IFRS9 减值、五级分类', roles:['Fintech 金融分析师','财务BP','财务分析'], strength:'强匹配', meta:'140亿信贷审阅 / 拨备+12pp / 评级95%+' },
    { id:'c-valuation', title:'估值建模', icon:'📊', desc:'DCF/FCFF/WACC、可比公司法、OPM、Black-Scholes、DLOM、CAPM', roles:['PE/VC 投资分析','投行承做','财务BP'], strength:'强匹配', meta:'20+项股权投资 / 20余只基金 / 40%提效' },
    { id:'c-control',   title:'内控与合规', icon:'🧾', desc:'SOX / C-SOX、穿行测试、控制测试、风险评估矩阵、ISA540', roles:['财务BP','内控/风控岗'], strength:'强匹配', meta:'6大内控循环 / 30+控制点 / 重大缺陷整改' },
    { id:'c-data',      title:'经营与财务数据分析', icon:'📈', desc:'SQL、Python、Power BI、SPSS、财务建模、自动化', roles:['互联网商业分析','产品经理(金融)','财务分析'], strength:'强匹配', meta:'SQL 10万+凭证 / Python 提效40% / VBA+SQL 50%' },
    { id:'c-gaap',      title:'合并报表 · 会计准则', icon:'🗂', desc:'合并抵消、IFRS/US GAAP、新收入准则、金融工具分类', roles:['财务分析','财务BP'], strength:'强匹配', meta:'200+笔抵消 / 双准则合规 / 10+份审计报告' },
    { id:'c-ai',        title:'AI · 数字化', icon:'🤖', desc:'Python/SQL 自动化实战 + 正在学习的后端/Agent 项目', roles:['互联网商业分析','数据岗','产品经理(金融)'], strength:'转岗·经历少', meta:'诚实标注：学习中的 agent/后端，主打自动化与学习力' }
  ],
  recs: [
    { label:'第一梯队 · 强匹配', items:[
      { role:'财务BP / 财务分析', why:'你的银行风控、估值建模、经营分析、合并报表四块能力天然贴合财务BP——既要懂业务又要懂财务，恰好是你在 PwC 多年的主战场', match: 90, gateway:'低' },
      { role:'Fintech 金融分析师', why:'IFRS9/IRB/ECL 是 Fintech 信贷风控的硬核对口，金融资产减值经历在全球金融科技公司直接可用', match: 88, gateway:'中' },
      { role:'互联网商业分析', why:'SQL/Python/Power BI + 财务建模 + 拆解驱动因子的能力，转商业分析只需把「财务语言」翻译成「业务语言」', match: 85, gateway:'中' }
    ]},
    { label:'第二梯队 · 需补知识', items:[
      { role:'PE/VC 投资分析', why:'DCF/OPM/可比公司/DLOM 估值功底扎实，是硬加分；但缺投资机构实习/实操与 deal 经验，需补', match: 75, gateway:'高(门槛)' },
      { role:'产品经理(金融)', why:'懂金融+懂数据，但缺产品方法论与案例，建议从金融产品岗位切入', match: 68, gateway:'中' },
      { role:'AI / 数据方向', why:'有 SQL/Python 基础与自动化实战，但缺 AI/agent 项目；用学习中的后端Agent资料补足，转岗是机会', match: 62, gateway:'中' }
    ]},
    { label:'谨慎 / 排除', items:[
      { role:'投行承做 (IBD)', why:'估值与财务功底是加分，但 IBD 对学历背景、实习、高强度 deal 经历要求高，现有经历偏审计', match: 58, gateway:'高' },
      { role:'审计 / 纯会计', why:'你明确不想做。你的经历虽通用于审计，但按目标应放下审计表述，转向分析/模型/风控口径', match: 20, gateway:'低(为你排除)' }
    ]}
  ],
  material: [
    { id:'m1', dirs:['风控','减值'], title:'信贷风险识别与预警 · 140亿存量信贷全量审阅', phase:['PwC 2023-2026 · 银行业'],
      bullets:[
        { dir:'通用', desc:'执行全量信贷审阅（Credit Review），覆盖 80%+ 存量贷款（合计 140 亿元），搭建「财务指标 + 押品估值 + 负面舆情」三维评估体系，优化 IRB 内部评级模型与押品估值方法，提升 ECL 模型对 PD/LGD 的测算精度，推动拨备覆盖率提升 12pp' },
        { dir:'Fintech 金融分析师', desc:'搭建覆盖偿债/盈利/营运/现金流的四维财务指标模型，建立客户信用风险评估矩阵并优化 PD/LGD 参数，预警 2 笔合计 2.4 亿元违约风险贷款（次年实际违约验证模型），将评级准确率提升至 95%+' },
        { dir:'财务BP / 财务分析', desc:'全量审阅 140 亿元贷款组合，搭建立体化的减值监测框架，输出覆盖财务指标、押品、舆情的风险画像；优化五级分类交叉验证机制，显著提升资产质量前瞻性与披露准确性' },
        { dir:'保险/互联网商业分析', desc:'用财务与舆情数据横向比较 80%+ 存量贷款主体的偿债能力，通过交叉验证（税务/司法/征信）识别高风险主体，量化信用风险敞口与预警信号' }
      ],
      kw:['Credit Review','IRB','PD','LGD','ECL','IFRS9','五级分类','风险矩阵','供应链金融/金融科技风控'],
      metrics:['140亿元','80%+','2.4亿元','95%+','+12pp'], source:'简历素材.docx' },
    { id:'m2', dirs:['估值'], title:'股权投资估值核验 · DCF/可比公司/OPM/B-S/DLOM', phase:['PwC 2023-2026 · TMT/股权投资'],
      bullets:[
        { dir:'通用', desc:'独立完成 20+ 项 FVTPL/FVOCI 口径非上市股权投资估值核验，运用收益法（FCFF 测算 + WACC 校验）、可比公司法（EV/EBITDA、EV/Sales、P/E 乘数）与 Backsolve 回溯法完成公允价值确认；采用 Black-Scholes 执行 OPM 股权价值分配，测算非上市股权流动性折扣（DLOM）' },
        { dir:'PE/VC 投资分析', desc:'对 20+ 项横跨早期至多轮优先股、含清算赎回特殊条款的投资标的做公允价值测算，用 DCF/可比公司/Backsolve 三法交叉验证；OPM+B-S 拆分多轮优先股价值，评估核心参数合理性，为投后估值提供依据' },
        { dir:'投行承做 / 估值', desc:'完成企业自由现金流（FCFF）预测与加权平均资本成本（WACC）推算，以可比公司法复核估值，运用 Black-Scholes/OPM 处理优先股与限售股，输出可审计的估值底稿' }
      ],
      kw:['DCF','FCFF','WACC','可比公司法','EV/EBITDA','OPM','Black-Scholes','DLOM','Backsolve','公允价值'],
      metrics:['20+项','多轮优先股','三法交叉','DLOM'], source:'简历素材.docx' },
    { id:'m3', dirs:['估值','数据'], title:'私募基金估值体系 & CAPM 非标债权定价', phase:['PwC 2023-2026 · 资管'],
      bullets:[
        { dir:'通用', desc:'主导 20 余只子基金、50+ 直投项目的估值与业绩评价体系建设，搭建标准化估值框架与作业流程；以市场乘数法计量直投公允价值，结合 Black-Scholes 与算术亚洲期权（AAP）测算限售/流动性折价；基于 CAPM 搭建非标固收债权估值框架，用 Python 自动化 ETL，估值效率提升 40%' },
        { dir:'PE/VC 投资分析', desc:'建立覆盖 20 余只基金的统一估值 SOP，用 IRR/DPI 构建基金业绩评价模型；盘活跨项目定性判断，将估值成果快速转化为投资委员会决策输入' },
        { dir:'财务BP / 数据分析', desc:'用 Python 自动化抓取债券评级/利率/财务比率并整合为估值基准库，搭建 CAPM 估值框架，整体作业提效 40%，量化支撑投资决策' }
      ],
      kw:['PE/VC 估值','SOP','IRR','DPI','算术亚洲期权','CAPM','ETL','Python'],
      metrics:['20余只基金','50+项目','+40%'], source:'简历素材.docx' },
    { id:'m4', dirs:['内控'], title:'SOX/C-SOX 内控体系 · 穿行/控制测试 · 风险矩阵', phase:['PwC 2023-2026 · 金融/制造'],
      bullets:[
        { dir:'通用', desc:'精通 SOX 与 C-SOX 合规要求，主导银行、券商、制造业等 6 大内控循环的全流程风险识别、穿行测试与控制测试；构建风险评估矩阵识别 30+ 关键控制点，牵头发现并推动一项重大控制缺陷整改落地；搭建制造业生产-成本-存货全流程内控体系，使生产成本差异核算精度提升至日度级别' },
        { dir:'财务BP / 内控岗', desc:'面向审计与管理层，把「6 大内控循环」翻译成可落地的风险控制矩阵，设计穿行测试与关键控制测试方案；推动重大缺陷的系统化整改，保证财报合规与运营效率' },
        { dir:'互联网商业分析（数据向）', desc:'梳理 120+ 业务节点流程，定位控制冗余与风险盲区，用数据驱动的方式量化关键风险控制点，将控制测试转化为可监控的指标，协助企业流程数字化' }
      ],
      kw:['SOX','C-SOX','穿行测试','控制测试','风险评估矩阵','ISA540','内控循环'],
      metrics:['6大循环','120+节点','30+控制点','日度精度'], source:'简历素材.docx' },
    { id:'m5', dirs:['数据'], title:'经营与财务数据分析 · SQL/Python/Power BI 自动化', phase:['PwC 2023-2026 · 券商/银行/港口'],
      bullets:[
        { dir:'通用', desc:'用 SQL 批量处理 10 万+ 条财务凭证与科目明细，设计五类高风险分录筛选规则，识别 150+ 条异常交易并在 56 家合并主体间做完整性测试；用 Python 抓取债券评级/利率/财务比率搭建估值基准库；以 VBA+SQL 开发工具处理千笔公司间交易抵消，审计审查效率提升 50%；构建银行利差分析模型（NIM/NIS）、港口收入拆解模型，用 SPSS/Stata 建模定位核心驱动因子' },
        { dir:'互联网商业分析', desc:'以 SQL 完成大样本财务数据的风险筛选与指标计算，用 Python 实现抓取-清洗-建模自动化，把复杂审计逻辑转化为可复用的数据管线；输出管理层看板与决策建议' },
        { dir:'产品经理(金融)', desc:'基于业务数据拆解收入/风险核心驱动因子，把「财务建模语言」转成「业务洞察」，为产品策略与风控规则提供数据支撑' }
      ],
      kw:['SQL','Python','Power BI','SPSS','Stata','ETL','NIM','NIS','完整性测试','自动化'],
      metrics:['10万+凭证','150+异常','56家主体','50%','40%'], source:'简历素材.docx' },
    { id:'m6', dirs:['准则','数据'], title:'合并报表 · IFRS/US GAAP · 收入准则', phase:['PwC 2023-2026 · 多行业'],
      bullets:[
        { dir:'通用', desc:'负责多集团合并报表编制，完成 200+ 笔关联方交易抵消；复核外币折算流程，保障 IFRS 与 US GAAP 双准则合规披露；精通新收入准则「五步法」与时点/时段确认，为港口、券商、制造多行业输出准则落地方案与会计处理优化（如券商积分合同负债、盐田港装卸时段确认）' },
        { dir:'财务BP / 财务分析', desc:'把 IFRS/US GAAP 双准则要求落地为可执行披露流程，主导集团间抵消与外币折算；对新收入准则应用做合规再造，量化收入确认口径调整对报表的影响' }
      ],
      kw:['合并报表','IFRS','US GAAP','新收入准则','五步法','外币折算','合同负债'],
      metrics:['200+笔','双准则','3000万+积分影响'], source:'简历素材.docx' },
    { id:'m7', dirs:['AI','数据'], title:'AI · 数字化（经历较少，诚实定位）', phase:['自学 · 后端/Agent 开发资料'],
      bullets:[
        { dir:'通用', desc:'有 SQL/Python 扎实基础与多个真实自动化项目（凭证筛查、估值 ETL、VBA+SQL 抵消工具）；正系统学习后端与 Agent 开发（Python 基础、Agent 概念、数据库、网络等），渴望把财务/数据能力迁移到 AI 应用' },
        { dir:'互联网商业分析', desc:'深耕真实业务数据自动化的同时，探索用大模型/Agent 重构财务与风控分析流程——以「能落地的数据分析+正在学习的 AI」为差异化' },
        { dir:'数据/产品(金融)', desc:'强调自动化提效的实际成果，清晰表达「从财务数据到 AI 应用」的迁移路径与学习投入，诚实展示成长曲线而非夸大' }
      ],
      kw:['Python','SQL','自动化','Agent','后端','学习'],
      metrics:['迁移期','多自动化项目'], source:'诚实标注 · 后端agent开发资料' }
  ]
};

/* ---------------- helpers ---------------- */
function toast(msg, type='') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + type; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(()=>{ t.hidden = true; }, 2600);
}
function uid(){ return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function tagExpand(txt){ // ：keword 高亮
  return esc(txt).replace(/\b([A-Za-z][A-Za-z0-9+/\-\.]{1,30})\b/g, '<span class="kw">$1</span>');
}
async function aiChat(messages, opts={}) {
  const r = await API.chat(messages, opts);
  if (r.error) toast(r.error, 'err');
  return r.content || '';
}

/* ---------------- config ---------------- */
function refreshConfigUI(){
  const c = state.config, el = $('#configState');
  if (c.hasKey) { el.textContent = 'AI 已配置 · ' + (c.keyMasked||''); el.className = 'config-state ok'; }
  else { el.textContent = 'API 未配置'; el.className = 'config-state no'; $('#buildNote') && (''); }
}
async function loadConfig(){ state.config = await API.config.get(); refreshConfigUI(); }
function openSettings(){
  $('#cfg-key').value = ''; $('#cfg-base').value = state.config.baseUrl || 'https://api.deepseek.com';
  $('#cfg-model').value = state.config.model || 'deepseek-chat';
  const cur = state.config.keyMasked; if (cur) $('#cfg-key').placeholder = '已配置('+cur+') 留空则不修改';
  $('#settingsModal').hidden = false;
}
async function saveConfig(){
  const key = $('#cfg-key').value.trim(); // 留空 = 不修改
  const body = { baseUrl: $('#cfg-base').value.trim() || 'https://api.deepseek.com', model: $('#cfg-model').value.trim() || 'deepseek-chat' };
  if (key) body.apiKey = key;
  const r = await API.config.set(body);
  if (r.ok){ await loadConfig(); $('#settingsModal').hidden = true; toast('配置已保存', 'ok'); }
}
async function testConn(){
  const key = $('#cfg-key').value.trim();
  const tmp = { baseUrl: $('#cfg-base').value.trim() || 'https://api.deepseek.com', model: $('#cfg-model').value.trim() || 'deepseek-chat' };
  if (key) tmp.apiKey = key;
  await API.config.set(tmp); await loadConfig();
  const st = $('#test-status'); st.textContent = '测试中…';
  const r = await API.chat([{role:'user', content:'请只回复两个字：OK'}]);
  st.textContent = r.error ? ('✗ ' + r.error) : '✓ 连接成功：' + (r.content||'').slice(0,20);
}

/* ---------------- store load / seed ---------------- */
const SEEDABLE = ['material','career','recs'];
async function loadStoreAll(){
  for (const k of Object.keys(state.resources)) {
    let arr = await API.store.get(k);
    if ((!arr || arr.length === 0) && SEEDABLE.includes(k)) {
      const seed = await API.seed.get(k);
      if (seed && seed.length) { await API.store.put(k, seed); arr = seed; }
    }
    // apply 是对象不是数组：{ profile, answers, history }
    if (k === 'apply') {
      state.applyDoc = (arr && typeof arr === 'object' && !Array.isArray(arr)) ? arr : null;
      continue;
    }
    state.resources[k] = Array.isArray(arr) ? arr : [];
  }
}

/* ---------------- tabs ---------------- */
function switchTab(tab){
  state.tab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.module').forEach(m => m.classList.toggle('active', m.id === 'mod-' + tab));
  render(tab);
}
function render(tab){
  if (tab === 'material') renderMaterial();
  else if (tab === 'knowledge') renderKnowledge();
  else if (tab === 'resume') renderResume();
  else if (tab === 'tracker') renderTracker();
  else if (tab === 'linkedin') renderLinkedin();
  else if (tab === 'apply') { $('#apply-app').innerHTML = renderApply(); bindApply(); }
}

/* ---------- 模块1 渲染 ---------- */
function renderMaterial(){
  const c = state.resources.career || [];
  const m = state.resources.material || [];
  const recs = (state.resources.recs && state.resources.recs.length) ? state.resources.recs : SEED.recs;
  const el = $('#material-app');
  el.innerHTML = `
    <div class="panel">
      <h4 class="panel-title">🎯 我的目标岗位方向 <span class="opt-in">（已按你的目标岗位归纳）</span></h4>
      <div class="grid grid-3" id="careerDirs"></div>
    </div>
    <div class="panel">
      <h4 class="panel-title">🧭 职业方向推荐 <span class="opt-in">（结合个人经历，诚实标注匹配度与门槛）</span></h4>
      <div id="careerRecs"></div>
    </div>
    <div class="panel">
      <h4 class="panel-title">📁 个人经历库 <span class="opt-in">（每条约目有多方向写法，可一键加入知识库）</span></h4>
      <div class="row" style="margin-bottom:12px">
        <button class="btn" id="mineBtn">💬 向我提问挖掘经历</button>
        <button class="btn" id="addExpBtn">＋ 手动添加经历</button>
        <div class="space"></div>
        <input id="expQ" placeholder="搜索经历关键词…" style="max-width:220px" />
      </div>
      <ul class="clean" id="expList"></ul>
    </div>
  `;
  $('#careerDirs').innerHTML = (c.length? c : SEED.career).map(x => `
    <div class="card">
      <div class="c-title">${x.icon} ${esc(x.title)}</div>
      <div class="c-meta">${esc(x.desc)}</div>
      <div class="c-body" style="margin-top:8px">
        <div style="margin:4px 0">目标岗位：${x.roles.map(r=>'<span class="tag b">'+esc(r)+'</span>').join(' ')}</div>
        <div class="tags">匹配：<span class="tag ${x.strength==='强匹配'?'g':'o'}">${esc(x.strength)}</span></div>
        <div class="opt-in" style="margin-top:6px">${esc(x.meta)}</div>
      </div>
    </div>`).join('');
  $('#careerRecs').innerHTML = recs.map(group => `
    <div style="margin-bottom:14px"><div class="c-title" style="margin-bottom:6px">${esc(group.label)}</div>
      ${group.items.map(it => `
        <li class="item-line" style="list-style:none">
          <div style="flex:1">
            <b>${esc(it.role)}</b> <span class="tag">匹配 ${it.match}%</span> <span class="tag ${it.gateway==='低'?'g':(it.gateway==='高'?'r':'o')}">门槛 ${esc(it.gateway)}</span>
            <div class="opt-in" style="margin-top:3px">${esc(it.why)}</div>
          </div>
        </li>`).join('')}
    </div>`).join('');

  const q = $('#expQ').value.trim().toLowerCase();
  const list = m.filter(x => !q || (x.title+x.bullets.map(b=>b.desc).join(' ')).toLowerCase().includes(q));
  $('#expList').innerHTML = list.length ? list.map(expCard).join('') : '<div class="empty">暂无经历，点「向我提问挖掘经历」或「手动添加」。</div>';

  $('#mineBtn').onclick = runMining;
  $('#addExpBtn').onclick = () => openExpEditor(null);
  $('#expQ').oninput = (e) => { $('#expQ').value = e.target.value; renderMaterial(); };
}

function expCard(x){
  const activeDir = x.activeDir || '通用';
  return `<li class="item-line" style="align-items:stretch;flex-direction:column;border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px;">
    <div class="row" style="justify-content:space-between">
      <div>
        <b>${esc(x.title)}</b>
        <div class="c-meta">${esc(x.phase)} · 来源：${esc(x.source||'')}</div>
      </div>
      <div class="row">
        <button class="btn btn-sm" onclick="openExpEditor('${x.id}')">✎ 编辑</button>
        <button class="btn btn-sm" onclick="delExp('${x.id}')">🗑</button>
        <button class="btn btn-sm btn-primary" onclick="addToKb('${x.id}')">＋加入知识库</button>
      </div>
    </div>
    <div class="row" style="margin-top:8px;gap:6px">
      ${x.dirs.map(d=>`<span class="tag ${d===activeDir?'b':''}">${esc(d)}</span>`).join('')}
      <span class="space"></span>
      <button class="btn btn-sm" onclick="setExpDir('${x.id}', '${esc(x.dirs[(x.dirs.indexOf(activeDir)+1)%x.dirs.length]||activeDir)}')">切换方向写法 ▸</button>
    </div>
    <div class="c-body" style="margin-top:8px">${esc((x.bullets.find(b=>b.dir===activeDir)||x.bullets[0]||{}).desc||'')}</div>
    <div class="opt-in" style="margin-top:8px">关键词：${(x.kw||[]).map(k=>'<span class="tag">'+esc(k)+'</span>').join(' ')}</div>
    <div class="opt-in" style="margin-top:6px">量化成果：${(x.metrics||[]).join(' · ')}</div>
  </li>`;
}
async function setExpDir(id, dir){
  const x = state.resources.material.find(a=>a.id===id); if(!x) return;
  x.activeDir = dir; await API.store.put('material', state.resources.material);
  renderMaterial();
}
async function delExp(id){
  if(!confirm('确定删除这条经历素材？')) return;
  state.resources.material = state.resources.material.filter(x=>x.id!==id);
  await API.store.put('material', state.resources.material); renderMaterial(); toast('已删除','ok');
}
function openExpEditor(id){
  const x = id ? state.resources.material.find(a=>a.id===id) : null;
  const html = `
    <div class="modal-overlay" id="expModal">
      <div class="modal" style="width:min(720px,94vw)">
        <div class="modal-head"><h3>${x?'编辑经历':'添加经历'}</h3><button class="btn btn-ghost" onclick="closeExpModal()">✕</button></div>
        <div class="modal-body">
          <label>标题<input id="ex-title" value="${esc(x?x.title:'')}" /></label>
          <label>阶段 / 来源<input id="ex-phase" value="${esc(x?x.phase:'')}" placeholder="如 PwC 2023-2026 · 银行业" /></label>
          <label>方向标签（逗号分隔）<input id="ex-dirs" value="${esc((x?x.dirs:['通用']).join(', '))}" /></label>
          <label>方向写法（每个方向一段，格式：方向 | 描述）
            <textarea id="ex-bullets" rows="8">${esc((x?x.bullets:[]).map(b=>b.dir+' | '+b.desc).join('\n'))}</textarea>
          </label>
          <label>关键词（逗号分隔）<input id="ex-kw" value="${esc((x?x.kw:[]).join(', '))}" /></label>
          <label>量化成果（逗号分隔）<input id="ex-metrics" value="${esc((x?x.metrics:[]).join(', '))}" /></label>
        </div>
        <div class="modal-foot"><span class="spacer"></span><button class="btn btn-ghost" onclick="closeExpModal()">取消</button><button class="btn btn-primary" onclick="saveExp('${x?x.id:''}')">保存</button></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
function closeExpModal(){ const m = $('#expModal'); if(m) m.remove(); }
async function saveExp(id){
  const txt = $('#ex-bullets').value.split('\n').filter(Boolean).map(l => { const i = l.split('|'); return { dir:(i[0]||'').trim(), desc:(i.slice(1).join('|')||'').trim() }; });
  const obj = {
    id: id || uid(),
    dirs: $('#ex-dirs').value.split(',').map(s=>s.trim()).filter(Boolean),
    title: $('#ex-title').value.trim(),
    phase: $('#ex-phase').value.trim(),
    bullets: txt, kw: $('#ex-kw').value.split(',').map(s=>s.trim()).filter(Boolean),
    metrics: $('#ex-metrics').value.split(',').map(s=>s.trim()).filter(Boolean),
    source: '手动添加'
  };
  const arr = state.resources.material;
  const i = arr.findIndex(a=>a.id===obj.id);
  if (i>=0) arr[i]=obj; else arr.push(obj);
  await API.store.put('material', arr); state.resources.material = arr;
  closeExpModal(); renderMaterial(); toast('已保存','ok');
}
function addToKb(id){
  state.pendingKbSource = id; switchTab('knowledge');
  // 模块2 若已实现，则读取 pendingKbSource 预填；否则给提示
  if (typeof renderKnowledge === 'function') toast('已跳转到知识库，选中该经历可查询生成','ok');
}
/* DeepSeek 驱动的经历挖掘 */
async function runMining(){
  if(!state.config.hasKey){ toast('请先在【设置】配置 DeepSeek API Key','err'); return; }
  const c = state.resources.career || [];
  const roleHint = c.map(x=>x.roles.join('/')).join('、');
  const intro = `你是资深简历与职业顾问，目标：帮我把工作/学业经历挖掘得更深入，匹配我的目标岗位。

我的目标岗位方向：${roleHint}
我不想做：审计/纯会计。对 AI 方向感兴趣但经历不多（请诚实处理，不夸大）。

请一对一、每次只问一个问题（共约 5-8 个问题），逐步挖出我经历中「现在简历还没写出来」的细节：具体动作、我做了什么决策、用了什么方法/模型/工具、是多少人/多少数据、结果提升了多少。第一个问题请直接开始，不要自我介绍。`;
  const box = prompt('已打开 AI 访谈挖掘。\n\n输入你的回答；输入“结束”退出。\n（建议：打开 DevTools，或直接把下面的访问函数复制到终端使用）\n\n对话将逐题进行，先把第一个问题告诉我？\n——点“确定”开始对话。', '开始');
  if (box === null) return;
  let q = intro;
  let turns = [ {role:'user', content:'开始访谈'} ];
  for (let i=0;i<10;i++){
    const reply = await aiChat(turns, {system:null});
    if(!reply) break;
    const latestQ = reply.split('\n').pop();
    turns.push({role:'assistant', content:reply});
    const ans = prompt('【AI访谈】\n'+reply+'\n\n—— 请回答（或输 结束）', '');
    if (ans === null || ans.trim()==='结束') break;
    turns.push({role:'user', content:ans});
  }
  toast('访谈结束：可在「手动添加经历」里整理新挖到的素材','ok');
}

/* ---------- 模块2：知识库 ---------- */
function renderKnowledge(){
  const el = $('#knowledge-app');
  const pending = state.pendingKbSource;
  const kb = state.resources.knowledge || [];
  const material = state.resources.material || [];
  const q = (state.kbQ||'').trim().toLowerCase();
  const list = kb.filter(k => !q || ((k.title||'')+' '+(k.content||'')).toLowerCase().includes(q));
  el.innerHTML = `<div class="panel">
    <h4 class="panel-title">🧠 知识库（${kb.length}） <span class="opt-in">从经历库生成「面试知识点 + 逐句代码示例」· 也可手动新建</span></h4>
    <div class="row" style="margin-bottom:10px">
      <select id="kb-src" style="max-width:360px">
        <option value="">选择一条经历素材…</option>
        ${material.map(x=>`<option value="${esc(x.id)}" ${x.id===pending?'selected':''}>${esc(x.title)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="kb-gen" onclick="genKnowledge()">✨ 生成面试知识点</button>
      <button class="btn btn-accent" onclick="newKb()">➕ 新建空白知识点</button>
      <div class="space"></div>
      <input id="kb-q" placeholder="搜索知识点…" style="max-width:200px" value="${esc(state.kbQ||'')}" />
    </div>
    ${pending?`<div class="hint" style="margin-bottom:8px">已从素材库选中一条经历，点「生成面试知识点」即可。</div>`:''}
    <ul class="clean">${list.length ? list.map(kbCard).join('') : '<div class="empty">暂无知识点。选一条经历点「生成面试知识点」，或点「➕ 新建空白知识点」自己写。</div>'}</ul>
  </div>
  ${kbModalHtml()}`;
  const qi=$('#kb-q'); if(qi) qi.oninput=(e)=>{ state.kbQ=e.target.value; renderKnowledge(); };
  $$('[data-kbview]',el).forEach(b=>b.onclick=()=>viewKb(b.dataset.kbview));
  $$('[data-kbdel]',el).forEach(b=>b.onclick=()=>delKb(b.dataset.kbdel));
  bindKbModal();
  state.pendingKbSource = null;
}
function kbCard(k){
  const gen = !!k.generating;
  return `<li class="item-line" style="align-items:stretch;flex-direction:column;border:1px solid ${gen?'var(--brand)':'var(--line)'};border-radius:10px;padding:14px;margin-bottom:10px;${gen?'background:#f6f8ff':''}">
    <div class="row" style="justify-content:space-between">
      <b>${gen?'⏳ ':''}${esc(k.title)}</b>
      <div class="row">
        ${gen
          ? `<span id="kb-run-${esc(k.id)}" class="opt-in" style="color:var(--brand);font-weight:600">正在生成… 0s</span>`
          : `<button class="btn btn-sm" data-kbview="${esc(k.id)}">查看 / 编辑</button>
             <button class="btn btn-sm btn-danger" data-kbdel="${esc(k.id)}">删除</button>`}
      </div>
    </div>
    <div class="opt-in" style="margin-top:6px">${gen?'内容生成中，完成后可查看、编辑、补图补链接':esc(new Date(k.createdAt).toLocaleString('zh-CN'))}${k.sourceExpId?' · 源自经历 #'+esc(k.sourceExpId):''}${k.manual?' · 手动录入':''}</div>
  </li>`;
}
/* ---------- 知识点查看 / 编辑弹窗（可补文字、图片、链接） ---------- */
function kbModalHtml(){
  const d = state.kbDraft;
  if(!d) return '';
  const editing = d.mode==='edit';
  return `<div class="modal-overlay" id="kbModal">
    <div class="modal" style="width:min(900px,94vw)">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h4 style="margin:0">${editing?'✏️ 编辑知识点':'📖 查看知识点'}</h4>
        <div class="row">
          ${editing
            ? `<button class="btn btn-primary" data-kbsave="1">💾 保存</button><button class="btn" data-kbpreview="1">👁 预览</button><button class="btn" data-kbcancel="1">取消</button>`
            : `<button class="btn btn-primary" data-kbedit="1">✏️ 编辑 / 补充内容</button><button class="btn" data-kbprint="1">🖨 新窗口预览</button><button class="btn" data-kbcancel="1">关闭</button>`}
        </div>
      </div>
      ${editing?`
        <label style="margin-top:12px">标题
          <input id="kb-m-title" value="${esc(d.title||'')}" placeholder="知识点标题" />
        </label>
        <div class="row" style="margin:8px 0">
          <button class="btn btn-sm" data-kbins="bold">**加粗**</button>
          <button class="btn btn-sm" data-kbins="h2">## 小标题</button>
          <button class="btn btn-sm" data-kbins="code">代码块</button>
          <button class="btn btn-sm" data-kbins="link">🔗 链接</button>
          <button class="btn btn-sm btn-accent" data-kbimg="1">🖼 插入图片</button>
          <input type="file" id="kb-img-file" accept="image/*" style="display:none" />
          <span class="opt-in">图片存到 data/uploads/，正文里插入 Markdown 图片语法</span>
        </div>
        <textarea id="kb-m-body" rows="18" style="font-family:var(--mono);font-size:13px;line-height:1.6" placeholder="支持 Markdown：## 标题、**加粗**、\`代码\`、\`\`\`代码块\`\`\`、[链接](url)、![图片](/uploads/xxx.png)">${esc(d.content||'')}</textarea>
      `:`
        <input type="hidden" id="kb-m-title" value="${esc(d.title||'')}" />
        <textarea id="kb-m-body" style="display:none">${esc(d.content||'')}</textarea>
        <h3 style="margin:14px 0 6px">${esc(d.title||'(无标题)')}</h3>
        <div class="kb-md">${mdToHtml(d.content||'')||'<div class="empty">还没有内容，点「✏️ 编辑 / 补充内容」开始写。</div>'}</div>
      `}
    </div>
  </div>`;
}
function bindKbModal(){
  const m=$('#kbModal'); if(!m) return;
  m.onclick=(e)=>{ if(e.target===m) closeKb(); };
  const g=(sel)=>{ const el=m.querySelector(sel); return el; };
  if(g('[data-kbcancel]')) g('[data-kbcancel]').onclick=closeKb;
  if(g('[data-kbedit]')) g('[data-kbedit]').onclick=()=>{ state.kbDraft.mode='edit'; renderKnowledge(); };
  if(g('[data-kbpreview]')) g('[data-kbpreview]').onclick=()=>{ pullKbDraft(); printKb(state.kbDraft); };
  if(g('[data-kbsave]')) g('[data-kbsave]').onclick=()=>saveKb();
  if(g('[data-kbprint]')) g('[data-kbprint]').onclick=()=>printKb(state.kbDraft);
  $$('[data-kbins]',m).forEach(b=>b.onclick=()=>insertKb(b.dataset.kbins));
  const imgBtn=g('[data-kbimg]'), imgFile=g('#kb-img-file');
  if(imgBtn&&imgFile) imgBtn.onclick=()=>imgFile.click();
  if(imgFile) imgFile.onchange=()=>uploadKbImage(imgFile);
}
function pullKbDraft(){
  if(!state.kbDraft) return;
  const t=$('#kb-m-title'), b=$('#kb-m-body');
  if(t && t.type!=='hidden') state.kbDraft.title=t.value;
  if(b) state.kbDraft.content=b.value;
}
function insertKb(kind){
  const ta=$('#kb-m-body'); if(!ta) return;
  const s=ta.selectionStart, e=ta.selectionEnd, sel=ta.value.slice(s,e);
  const wraps={ bold:['**','**','粗体文字'], h2:['\\n## ','\\n','小标题'], code:['\\n```\\n','\\n```\\n','代码'] };
  let ins;
  if(kind==='link'){
    const url=prompt('链接地址（https://…）'); if(!url) return;
    const text=prompt('显示文字', sel||url); if(text===null) return;
    ins=`[${text||url}](${url})`;
  } else {
    const w=wraps[kind]; if(!w) return;
    ins = w[0] + (sel||w[2]) + w[1];
  }
  ta.value = ta.value.slice(0,s) + ins + ta.value.slice(e);
  ta.focus(); ta.selectionStart=ta.selectionEnd=s+ins.length;
  if(state.kbDraft) state.kbDraft.content=ta.value;
}
async function uploadKbImage(input){
  const f=input.files && input.files[0]; if(!f) return;
  if(f.size > 8*1024*1024){ toast('图片超过 8MB，请压缩后重试','err'); input.value=''; return; }
  toast('正在上传图片…');
  try {
    const b64=await fileToBase64(f);
    const r=await API.uploadImage({ filename:f.name, fileBase64:b64 });
    if(r.error){ toast(r.error,'err'); input.value=''; return; }
    const name=(state.kbDraft&&state.kbDraft.title)||'图片';
    insertKbRaw(`\n![${name}](${r.url})\n`);
    toast('图片已插入正文（保存后生效）','ok');
  } catch(e){ toast('上传失败：'+((e&&e.message)||e),'err'); }
  input.value='';
}
function insertKbRaw(text){
  const ta=$('#kb-m-body'); if(!ta) return;
  const s=ta.selectionStart==null?ta.value.length:ta.selectionStart;
  ta.value=ta.value.slice(0,s)+text+ta.value.slice(ta.selectionEnd==null?s:ta.selectionEnd);
  if(state.kbDraft) state.kbDraft.content=ta.value;
}
function newKb(){
  state.kbDraft={ id:'', title:'', content:'', createdAt:'', manual:true, mode:'edit' };
  renderKnowledge();
}
function viewKb(id){
  const k=(state.resources.knowledge||[]).find(x=>x.id===id); if(!k) return;
  if(k.generating){ toast('还在生成中，稍等…'); return; }
  state.kbDraft={ id:k.id, title:k.title||'', content:k.content||'', createdAt:k.createdAt||'', sourceExpId:k.sourceExpId, manual:k.manual, mode:'view' };
  renderKnowledge();
}
function closeKb(){ state.kbDraft=null; renderKnowledge(); }
async function saveKb(){
  const d=state.kbDraft; if(!d) return;
  pullKbDraft();
  const title=(d.title||'').trim() || '未命名知识点';
  if(!d.id){
    const item={ id:uid(), title, content:d.content||'', manual:true, createdAt:new Date().toISOString() };
    try {
      const r=await API.store.add('knowledge', item);
      state.resources.knowledge.push(r.item || item);
    } catch(e){ toast('保存失败：'+((e&&e.message)||e),'err'); return; }
  } else {
    const cur=(state.resources.knowledge||[]).find(x=>x.id===d.id);
    if(!cur) return;
    cur.title=title; cur.content=d.content||'';
    try { await API.store.put('knowledge', state.resources.knowledge.filter(k=>!k.generating)); }
    catch(e){ toast('保存失败：'+((e&&e.message)||e),'err'); return; }
  }
  state.kbDraft=null; renderKnowledge(); toast('已保存','ok');
}
function printKb(d){
  if(!d) return;
  const w=window.open('','_blank');
  if(!w){ toast('弹窗被拦截，请允许后重试','err'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(d.title||'知识点')}</title>
<style>body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:36px;line-height:1.75;font-size:14px;max-width:820px;color:#222}
h3{margin:0 0 4px}pre,.kb-pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto;font-size:12.5px}
code{background:#f0f2f5;padding:1px 4px;border-radius:4px}img{max-width:100%;border-radius:8px;margin:10px 0}
a{color:#0a66c2}ul{padding-left:22px}</style></head>
<body><h3>${esc(d.title||'知识点')}</h3><div class="kb-md">${mdToHtml(d.content||'')}</div></body></html>`);
  w.document.close();
}
/* 极简 Markdown → HTML（先转义再转换，避免注入） */
function mdToHtml(md){
  const src=String(md||'').split('\n');
  const out=[], para=[], list=[];
  const flushP=()=>{ if(para.length){ const t=para.join('<br>').trim(); if(t) out.push('<p>'+t+'</p>'); para.length=0; } };
  const flushL=()=>{ if(list.length){ out.push('<ul>'+list.join('')+'</ul>'); list.length=0; } };
  const inline=(t)=>esc(t)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,(m,alt,url)=>'<img src="'+url+'" alt="'+alt+'">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(m,txt,url)=>'<a href="'+url+'" target="_blank" rel="noopener">'+txt+'</a>')
    .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')
    .replace(/`([^`\n]+)`/g,'<code>$1</code>');
  for(let i=0;i<src.length;i++){
    const ln=src[i];
    if(/^\s*```/.test(ln)){                       // 代码块整段原样保留（只转义）
      const buf=[]; i++;
      while(i<src.length && !/^\s*```/.test(src[i])){ buf.push(src[i]); i++; }
      flushP(); flushL();
      out.push('<pre class="kb-pre"><code>'+esc(buf.join('\n'))+'</code></pre>');
      continue;
    }
    if(!ln.trim()){ flushP(); flushL(); continue; }
    const h=ln.match(/^(#{1,6})\s+(.*)$/);
    if(h){ flushP(); flushL(); const lv=Math.min(Math.max(h[1].length+1,3),6); out.push('<h'+lv+'>'+inline(h[2])+'</h'+lv+'>'); continue; }
    const li=ln.match(/^\s*[-*]\s+(.*)$/);
    if(li){ flushP(); list.push('<li>'+inline(li[1])+'</li>'); continue; }
    if(/^\s*!\[/.test(ln)){ flushP(); flushL(); out.push(inline(ln.trim())); continue; }
    flushL(); para.push(inline(ln));
  }
  flushP(); flushL();
  return out.join('\n');
}
async function genKnowledge(){
  if(state.kbBusy){ toast('正在生成中，请稍候…'); return; }
  if(!state.config.hasKey){ toast('请先在【设置】配置 DeepSeek API Key','err'); return; }
  const id=$('#kb-src') && $('#kb-src').value;
  if(!id){ toast('请先在下拉里选择一条经历素材','err'); return; }
  const x=(state.resources.material||[]).find(m=>m.id===id); if(!x){ toast('未找到该经历','err'); return; }
  const desc=((x.bullets||[]).find(b=>b.dir===(x.activeDir||'通用'))||(x.bullets||[])[0]||{}).desc||'';
  const t0=Date.now();
  state.kbBusy=true;
  // 1) 立刻插入一条"生成中"的占位卡片（只在前端，生成成功才落盘）
  const ph={ id:uid(), title:x.title, content:'', sourceExpId:x.id, generating:true, createdAt:new Date().toISOString() };
  state.resources.knowledge.unshift(ph);
  renderKnowledge();
  const tick=()=>{
    const sec=Math.round((Date.now()-t0)/1000);
    const lab=document.getElementById('kb-run-'+ph.id);
    if(lab) lab.textContent='正在生成… '+sec+'s（约需 60-90 秒）';
    const btn=$('#kb-gen');
    if(btn && document.contains(btn)){ btn.disabled=true; btn.textContent='⏳ 生成中 '+sec+'s'; }
  };
  tick();
  const timer=setInterval(tick,1000);
  toast('已加入知识库，正在生成（约 60-90 秒），别关页面…');
  const prompt=`你是资深面试辅导与专业导师。基于下面这条真实经历，生成面试可用的「专业知识点 + 逐句代码示例 + 高频追问 + 回答要点」。

经历标题：${x.title}
阶段：${x.phase}
经历描述：${desc}
关键词：${(x.kw||[]).join('、')}
量化成果：${(x.metrics||[]).join('、')}

用 Markdown 输出，结构：
## 核心知识点（3-5 条，每条一句话讲清专业概念）
## 代码示例（如涉及 Python/SQL/自动化，给逐句注释的可运行片段；不涉及则写「本经历无代码」）
## 高频追问（3-5 个面试官会追的问题）
## 回答要点（每条对应 STAR 要点，严格基于真实经历，不编造）`;
  try {
    const out=await aiChat([{role:'user',content:prompt}]);
    if(!out){ toast('模型没返回内容，请重试','err'); return; }
    const item={ id:ph.id, sourceExpId:x.id, title:x.title, content:out, createdAt:new Date().toISOString() };
    await API.store.add('knowledge', item);
    ph.generating=false; ph.content=out; ph.createdAt=item.createdAt;
    renderKnowledge();
    toast('已生成并保存到知识库（用时 '+Math.round((Date.now()-t0)/1000)+'s）','ok');
  } catch(e){
    state.resources.knowledge=state.resources.knowledge.filter(k=>k.id!==ph.id);
    renderKnowledge();
    toast('生成失败：'+((e&&e.message)||e),'err');
  } finally {
    state.kbBusy=false;
    if(timer) clearInterval(timer);
    const btn=$('#kb-gen');
    if(btn && document.contains(btn)){ btn.disabled=false; btn.textContent='✨ 生成面试知识点'; }
  }
}
function viewKb(id){
  const k=(state.resources.knowledge||[]).find(x=>x.id===id); if(!k)return;
  const w=window.open('','_blank'); w.document.write(`<html><head><meta charset="utf-8"><title>${esc(k.title)}</title><style>body{font-family:Arial,sans-serif;margin:36px;line-height:1.7;font-size:14px;max-width:760px}pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}</style></head><body><h2>${esc(k.title)}</h2><pre style="white-space:pre-wrap">${esc(k.content)}</pre></body></html>`); w.document.close();
}
async function delKb(id){ if(!confirm('删除该知识点？'))return; await API.store.del('knowledge', id); state.resources.knowledge=state.resources.knowledge.filter(x=>x.id!==id); renderKnowledge(); toast('已删除','ok'); }
/* ############### 模块3：机会库 + 基础简历 + Cover Letter + 简历库 ############### */
const DEFAULT_ZH = `纪子悦
现居香港 · +86 13635260153 · sophiaji2001@gmail.com
linkedin.com/in/子悦-纪-51112b373/

教育经历
香港大学(HKU) 硕士 计算机科学(E-Commerce and Internet Computing)   2026.09-2027.11
主要课程：电子商务技术、数字化转型、知识图谱、商业与电商机器学习、计算智能与机器学习
香港浸会大学(HKBU) 会计学 本科（一等荣誉学位）   2019.09-2023.06
GPA 3.62/4.00｜全校二等奖学金｜学生实习实践奖学金；十一届电子商务"三创"挑战赛 广东省二等奖

工作经历
普华永道中天会计师事务所 高级审计员  2023.10-2026.09
深耕金融、TMT、制造业，核心覆盖风控体系、估值建模、经营分析、会计处理，熟练运用 Python、SQL、Power BI 自动化与提效
• 金融资产估值：DCF(FCFF/WACC)、可比公司法、Backsolve 完成公允价值验证，20+ 项非上市股权投资；Black-Scholes 执行 OPM 股权价值分配、测算 DLOM；主导 20 余只私募基金估值体系（50+ 直投项目），效率+40%
• 内控体系：精通 SOX/C-SOX，主导多行业全业务循环风险识别、穿行测试与控制测试；搭建制造业生产-成本-存货全流程内控体系，成本差异核算精度提升至日度
• 金融资产减值：主导 140 亿存量信贷全量审阅，预警 2 笔合计 2.4 亿违约风险贷款，五级分类交叉验证，评级准确率 95%+；搭建 IFRS9 分类矩阵与多场景 DCF 减值模型，优化 IRB 内部评级(PD/LGD)，拨备覆盖率 +12pp
• 数据分析：用 SQL 处理 10 万+ 财务凭证、五类高风险筛选规则，识别 150+ 异常交易（覆盖 56 家合并主体）；Python 抓取债券评级/利率建估值基准库(+40%)；Stata 多元回归建模识别收入核心驱动因子
• 合并报表与准则：负责多集团合并报表编制，开发 VBA+SQL 自动化工具，批量处理千笔公司间交易抵消，效率提升 50%，支持 IFRS/US GAAP 双准则合规披露；带队出具 10+ 份集团审计报告，覆盖 7 家子公司，识别多项会计处理与内控管理缺陷
• 精通新收入准则、金融工具准则，为 TMT、金融、制造等多行业输出准则落地方案与会计处理优化建议

项目经历
智能财务分析 Agent · 独立开发    2026
用 DeepSeek LLM + Function Calling 搭建智能财务分析 Agent：FastAPI 服务 + Docker + GitHub Actions CI（pytest）；Agent 自动组合「SQL 查询 → 财务模型计算 → 会计准则 RAG 检索 → 子进程脚本」工具链，含只读 SQL / 超时安全约束与结构化 tool_trace 可观测日志，输出带依据的结构化分析报告
求职工作台 & 课程笔记 Agent Skill · 用 Claude Code 开发    2026
用 Claude Code 从 0 开发个人求职工作台（Node/Express 后端 + 单页前端），集成 DeepSeek LLM API 完成 JD 分析、经历润色、面试题生成，解析 1500+ 岗位 Excel 并支持 PDF 导出；开发「课程笔记整理」Agent Skill，将港硕课件 PDF 分节生成中英双语课时页、逐行讲解算法、自动判分练习题（内嵌 Pyodide 可运行代码工作区），覆盖 3 门课程

实习经历
普华永道中天会计师事务所 审计实习生  2022.01-2022.03
港股上市银行年度审计：负责 8+ 个科目审计（拆分明细、审计调整、变动分析、披露、测算/抽凭）；制作函证控制表，负责所有函证 200+
华兴会计师事务所 审计实习生  2021.06-2021.09
建筑工程公司净资产专项审计：参与六大往来款底稿，编制重分类调整分录，账龄复核，内部往来逐笔核对，制发往来款函证与抽凭；完成团队近 30% 基础性工作，获一致好评
中国平安保险(集团) 客户经理助理  2020.07-2020.09
入职培训考试 96 分（前 5%），带领 8 人团队获全班第一、"优秀团队"证书；协助讲师每日 3 例案例分析及 1-2 件产品介绍；任讲师助理，帮助近百位新人岗前培训，80%+ 通过结训考试

技能与证书
证书：微软 MOS Excel 专家级、微软 MTA Python 国际、英语 CET-6、CET-4
语言：英语(IELTS 7.5，本硕全英教学)、粤语(流利)、普通话(母语)
技能：Office、SQL、Python、Power BI`;

const DEFAULT_EN = `JI Ziyue (Sophia)
Hong Kong · +86 13635260153 · sophiaji2001@gmail.com
linkedin.com/in/子悦-纪-51112b373/

EDUCATION
The University of Hong Kong (HKU)     Hong Kong
MSc, Computer Science (E-Commerce and Internet Computing)     Sep 2026 - Nov 2027
Relevant coursework: E-Commerce Technology, Digital Transformation, Knowledge Graphs, Machine Learning for Business & E-Commerce, Computational Intelligence & Machine Learning

Beijing Normal - Hong Kong Baptist University (HKBU)     Zhuhai
BBA (Honours) in Accounting, First-Class Honours     Sep 2019 - Jun 2023
GPA 3.62/4.00 | University Second-Class Scholarship | Student Internship/Practice Scholarship
2nd Prize, Guangdong Provincial E-commerce "Innovation, Creativity & Entrepreneurship" Challenge

WORK EXPERIENCE
PricewaterhouseCoopers (PwC) Zhong Tian LLP     Senior Auditor     Oct 2023 - Sep 2026
Deep experience across finance, TMT and manufacturing: risk control systems, valuation modelling, operational & financial analysis and accounting; automated workflows using Python, SQL and Power BI.
- Financial asset valuation: Verified fair value via DCF (FCFF/WACC), comparable companies and Backsolve for 20+ unlisted equity investments; used Black-Scholes to allocate value via OPM and measure DLOM; led a valuation framework for 20+ PE funds (50+ direct projects, +40% efficiency)
- Internal controls: SOX / C-SOX; risk identification, walkthrough & control testing across full business cycles; built a production-cost-inventory control framework (daily cost-variance granularity)
- Financial asset impairment: Reviewed RMB 14bn of loans and flagged two high-risk loans totaling RMB 240m; 5-tier classification cross-check with 95%+ rating accuracy; IFRS9 classification matrix + multi-scenario DCF impairment; optimized IRB (PD/LGD), lifting the provision coverage ratio by 12pp
- Data & analytics: Processed 100k+ journal entries via SQL with 5 high-risk filters (150+ anomalies across 56 entities); automated bond/rate data ingestion in Python (+40%); Stata regression to identify revenue drivers
- Consolidation & standards: Led consolidated financial statement preparation for multiple groups; developed VBA+SQL automation tools to offset 1,000+ intercompany transactions (+50% efficiency) under IFRS/US GAAP; led the issuance of 10+ group audit reports covering 7 subsidiaries, identifying multiple accounting and internal-control deficiencies
- Proficient in new revenue-recognition and financial-instruments standards; delivered implementation and accounting-treatment solutions for TMT, finance and manufacturing clients

PROJECTS
Intelligent Financial Analysis Agent · Independent Project    2026
Built an LLM-powered financial analysis agent with DeepSeek + Function Calling on a FastAPI backend with Docker and GitHub Actions CI (pytest); the agent chains read-only SQL (SQLite), standard financial models (margin/liquidity/leverage/ROE/ROA/turnover/WACC/DCF/IRR/ECL), RAG retrieval of accounting standards (TF-IDF) and a sandboxed subprocess calculator, with read-only SQL, timeouts and structured tool_trace observability, producing evidence-backed analysis reports
Job Application Workbench & Course-Notes Agent Skill · Built with Claude Code    2026
Built a personal job-application workbench from scratch with Claude Code (Node/Express backend + single-page frontend), integrating the DeepSeek LLM API for JD analysis, experience polishing and interview-question generation, parsing a 1,500+ job Excel sheet with PDF export; also built a "course-notes" Agent Skill that splits HKU lecture PDFs into bilingual lesson pages, explains algorithms line by line and auto-generates graded exercises (single-choice, multiple-choice, fill-in-the-blank) with an in-browser runnable code workspace (Pyodide), covering 3 courses

INTERNSHIP EXPERIENCE
PwC Zhong Tian LLP     Audit Intern     Jan 2022 - Mar 2022
Listed HK bank annual audit: owned 8+ subjects (breakdown, audit adjustments, variance analysis, disclosure, testing & sampling); built the confirmation control sheet and managed 200+ confirmations
Huaxing CPA     Audit Intern     Jun 2021 - Sep 2021
Net-asset special audit for a construction firm: 6 intercompany working papers, reclassification entries, ageing analysis, reconciling internal transactions, confirmations & sampling; about 30% of the team's foundational work
Ping An Insurance (Group)     Client Manager Assistant     Jul 2020 - Sep 2020
Scored 96/100 (top 5%) in the onboarding exam; led an 8-person team to #1 ("Outstanding Team"); supported daily case analysis & product intros; trained ~100 new hires (80%+ passed)

SKILLS & CERTIFICATIONS
Certifications: Microsoft MOS Excel Expert, MTA Python International, CET-6, CET-4
Languages: English (IELTS 7.5, full English instruction), Cantonese (fluent), Mandarin (native)
Tools: Office, SQL, Python, Power BI`;

const DEFAULT_TW = `紀子悅
現居香港 · +86 13635260153 · sophiaji2001@gmail.com
linkedin.com/in/子悅-紀-51112b373/

教育經歷
香港大學（HKU） 碩士 計算機科學（E-Commerce and Internet Computing）   2026.09-2027.11
主要課程：電子商務技術、數碼轉型、知識圖譜、商業與電商機器學習、計算智能與機器學習
香港浸會大學（HKBU） 會計學 本科（一級榮譽學位）   2019.09-2023.06
GPA 3.62/4.00｜全校二等獎學金｜學生實習實踐獎學金；十一屆大學生電子商務「三創」挑戰賽 廣東省二等獎

工作經歷
普華永道中天會計師事務所 高級審計員  2023.10-2026.09
深耕金融、TMT、製造業，核心覆蓋風控體系、估值建模、經營分析、會計處理，熟練運用 Python、SQL、Power BI 自動化與提效
• 金融資產估值：以 DCF（FCFF/WACC）、可比公司法、Backsolve 完成公允價值驗證，20+ 項非上市股權投資；Black-Scholes 執行 OPM 股權價值分配、測算 DLOM；主導 20 餘隻私募基金估值體系（50+ 直接投資項目），效率 +40%
• 內控體系：精通 SOX/C-SOX，主導多行業全業務循環風險識別、穿行測試與控制測試；搭建製造業生產-成本-存貨全流程內控體系，成本差異核算精度提升至日度
• 金融資產減值：主導 140 億存量信貸全量審閱，預警 2 筆合計 2.4 億違約風險貸款，五級分類交叉驗證，評級準確率 95%+；搭建 IFRS9 分類矩陣與多情景 DCF 減值模型，優化 IRB 內部評級（PD/LGD），撥備覆蓋率 +12pp
• 數據分析：以 SQL 處理 10 萬+ 財務憑證、五類高風險篩選規則，識別 150+ 異常交易（覆蓋 56 家合併主體）；Python 抓取債券評級/利率建估值基準庫（+40%）；Stata 多元回歸建模識別收入核心驅動因素
• 合併報表與準則：負責多集團合併報表編製，開發 VBA+SQL 自動化工具，批量處理千筆公司間交易抵消，效率提升 50%，支持 IFRS/US GAAP 雙準則合規披露；帶隊出具 10+ 份集團審計報告，覆蓋 7 家子公司，識別多項會計處理與內控管理缺陷
• 精通新收入準則、金融工具準則，為 TMT、金融、製造等多行業輸出準則落地方案與會計處理優化建議

項目經歷
智能財務分析 Agent · 獨立開發    2026
以 DeepSeek LLM + Function Calling 搭建智能財務分析 Agent：FastAPI 服務 + Docker + GitHub Actions CI（pytest）；Agent 自動組合「SQL 查詢 → 財務模型計算 → 會計準則 RAG 檢索 → 子進程腳本」工具鏈，含只讀 SQL / 逾時安全約束與結構化 tool_trace 可觀測日誌，輸出附依據的結構化分析報告
求職工作台 & 課程筆記 Agent Skill · 以 Claude Code 開發    2026
以 Claude Code 從零開發個人求職工作台（Node/Express 後端 + 單頁前端），整合 DeepSeek LLM API 完成 JD 分析、經歷潤色、面試題生成，解析 1500+ 崗位 Excel 並支持 PDF 導出；開發「課程筆記整理」Agent Skill，將港碩課件 PDF 分節生成中英雙語課時頁、逐行講解算法、自動判分練習題（內嵌 Pyodide 可運行代碼工作區），覆蓋 3 門課程

實習經歷
普華永道中天會計師事務所 審計實習生  2022.01-2022.03
港股上市銀行年度審計：負責 8+ 個科目審計（拆分明細、審計調整、變動分析、披露、測算/抽憑）；製作函證控制表，負責所有函證 200+
華興會計師事務所 審計實習生  2021.06-2021.09
建築工程公司淨資產專項審計：參與六大往來款底稿，編製重分類調整分錄，帳齡覆核，內部往來逐筆核對，製發往來款函證與抽憑；完成團隊近 30% 基礎性工作，獲一致好評
中國平安保險（集團） 客戶經理助理  2020.07-2020.09
入職培訓考試 96 分（前 5%），帶領 8 人團隊獲全班第一、「優秀團隊」證書；協助講師每日 3 例案例分析及 1-2 件產品介紹；任講師助理，幫助近百位新人崗前培訓，80%+ 通過結訓考試

技能與證書
證書：微軟 MOS Excel 專家級、微軟 MTA Python 國際、英語 CET-6、CET-4
語言：英語（IELTS 7.5，本碩全英教學）、粵語（流利）、普通話（母語）
技能：Office、SQL、Python、Power BI`;

const DEFAULT_COVER = `Subject: Application for [Job Title] at [Company]

Dear Hiring Manager,

I am writing to apply for the [Job Title] role at [Company]. With a strong foundation in finance, risk, and data analytics gained over three years at PwC, and my current MSc in Electronic Commerce & Internet Computing at HKU, I bring a rare blend of financial depth and technical capability to support [specific goal].

At PwC, I led credit-risk reviews across RMB 14bn of loans (refining IRB/ECL models and lifting rating accuracy to 95%+), verified 20+ private-equity valuations (DCF, comparable companies, OPM, Black-Scholes), and automated large-scale analysis with SQL and Python - improving efficiency by 40-50%.

I am especially drawn to [Company] because [specific reason]. I am eager to apply my analytical rigor and cross-functional collaboration to drive value for your team.

Sincerely,
JI Ziyue (Sophia)`;

function renderResume(){
  const sub = state.resumeSub || 'jobs';
  const el = $('#resume-app');
  const tabs = [['jobs','🗂 机会库'],['jd','🧾 JD 工作台'],['tailor','🎯 定制简历'],['cover','✉️ Cover Letter'],['layout','📐 简历排版'],['lib','🗃 简历库'],['interview','🎯 面试练习']];
  el.innerHTML = `
    <div class="subtabs">${tabs.map(t=>`<button class="subtab ${sub===t[0]?'active':''}" data-sub="${t[0]}">${t[1]}</button>`).join('')}</div>
    <div id="resumeSubBody"></div>`;
  $$('.subtab', el).forEach(b=>b.onclick=()=>{ state.resumeSub=b.dataset.sub; renderResume(); });
  $('#resumeSubBody').innerHTML = sub==='jobs' ? jobsHtml()
    : sub==='jd' ? renderJdWorkbench()
    : sub==='tailor' ? renderTailor()
    : sub==='cover' ? baseResumeHtml('cover', DEFAULT_COVER)
    : sub==='layout' ? cvHtml()
    : sub==='lib' ? resumeLibHtml()
    : interviewHtml();
  if(sub==='jobs') bindJobs();
  else if(sub==='jd') bindJdWorkbench();
  else if(sub==='layout') bindCv();
}

/* ---------- 机会库 ---------- */
function jobsHtml(){
  const f = state.jobFilter;
  const c = state.resources.jobs || [];
  const regionOpts = [['all','全部(2150)'],['hks','🇭🇰香港+🇨🇳深圳'],['hk','仅香港'],['sz','仅深圳']];
  return `
    <div class="panel">
      <h4 class="panel-title">🌐 接入在线文档 · 一键导入 <span class="opt-in">（飞书/QQ笔记需登录，你在自己浏览器登录后提取；我无法直接抓登录页）</span></h4>
      <div class="row">
        <button class="btn" id="oi-help">💡 如何导入</button>
        <button class="btn" id="oi-snippet">📋 复制「浏览器取表」代码</button>
        <input id="oi-url" placeholder="飞书Base/招聘网站地址（可选，供记录）" style="max-width:300px" />
        <div class="space"></div>
        <button class="btn" id="oi-toggle">⬇ 粘贴导入</button>
      </div>
      <div id="oi-helpbox" class="hint" style="display:none;margin-top:8px">
        方式A（飞书多维表格，最稳）：登录飞书 → 打开该表 → 右上角「…」→ 导出 → Excel/CSV → 保存到电脑「机会汇总」文件夹 → 点机会库的「↻ 一键更新」。<br/>
        方式B（网页表格 / QQ笔记 等）：点「复制浏览器取表代码」→ 在已登录页面按 F12 打开控制台粘贴回车（表格已复制）→ 粘贴到下方输入框 → 点「解析并导入」。<br/>
        方式C（手动）：从 Excel 选中表格区域复制（含表头），粘贴到下方输入框。
      </div>
      <div id="oi-area" style="display:none;margin-top:10px">
        <textarea id="oi-paste" rows="6" placeholder="粘贴从网页/飞书/Excel 复制的表格（列名含：公司/岗位/类型/地点/截止日期/链接）"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn btn-primary" id="oi-run">解析并导入到机会库</button><span id="oi-status" class="opt-in"></span></div>
      </div>
    </div>
    <div class="panel">
      <h4 class="panel-title">🗂 机会库 <span class="opt-in">（本地 Excel：${c.length} 条 · 🔗 带链接 ${state.resources.jobs.filter(j=>j.applyUrl).length} 条）</span></h4>
      <div class="row" style="margin-bottom:12px">
        <select id="jf-region">${regionOpts.map(o=>`<option value="${o[0]}" ${f.region===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select>
        <select id="jf-work">
          <option value="all" ${f.workType==='all'?'selected':''}>全部类型</option>
          <option value="实习" ${f.workType==='实习'?'selected':''}>实习</option>
          <option value="校招" ${f.workType==='校招'?'selected':''}>校招/全职</option>
          <option value="其他" ${f.workType==='其他'?'selected':''}>其他</option>
        </select>
        <input id="jf-q" placeholder="搜公司/岗位关键词…" value="${esc(f.q)}" style="max-width:200px" />
        <div class="space"></div>
        <button class="btn" id="jobsUpdateBtn">↻ 一键更新</button>
        <button class="btn btn-accent" id="jobsRefreshBtn">刷新筛选</button>
      </div>
      <div id="jobsTable">${jobsTableHtml()}</div>
    </div>`;
}
function filterJobs(){
  const f = state.jobFilter; const c = state.resources.jobs || [];
  let r = c;
  const loc = (x)=>(x&&x.location?x.location:'').toLowerCase();
  if(f.region==='hk') r=r.filter(x=>loc(x).includes('香港'));
  else if(f.region==='sz') r=r.filter(x=>loc(x).includes('深圳'));
  else if(f.region==='hks') r=r.filter(x=>loc(x).includes('香港')||loc(x).includes('深圳'));
  if(f.workType!=='all') r=r.filter(x=>String(x.workType||'').includes(f.workType));
  if(f.q){ const q=f.q.toLowerCase(); r=r.filter(x=>(x.company+' '+x.title+' '+(x.industry||'')).toLowerCase().includes(q)); }
  return r;
}
function deadRank(j){ const d=String(j.deadline||''); if(!d) return 3; if(/尽快|随时|招满|马上|长期/.test(d)) return 0; const m=d.match(/^\d{4}-\d{2}-\d{2}/); return m?1:2; }
function deadVal(j){ const m=String(j.deadline||'').match(/^\d{4}-\d{2}-\d{2}/); return m?m[0]:'9999-99-99'; }
function jobsTableHtml(){
  const list = filterJobs();
  // 按工作类型分组
  const groups = {};
  list.forEach(j=>{ const g=String(j.workType||'其他'); (groups[g]=groups[g]||[]).push(j); });
  const order = ['实习','校招','其他'];
  const gkeys = ['实习','校招','其他'].filter(g=>groups[g]).concat(Object.keys(groups).filter(g=>!order.includes(g)));
  let html = `<div class="tbl-track"><table class="tbl"><thead><tr>
    <th>公司</th><th>岗位</th><th>行业</th><th>类型</th><th>地点</th><th>更新</th><th>截止</th><th>链接</th><th>操作</th></tr></thead><tbody>`;
  for(const g of gkeys){
    const items = groups[g].slice().sort((a,b)=> deadRank(a)-deadRank(b) || deadVal(a).localeCompare(deadVal(b)));
    html += `<tr><td colspan="9" style="background:#eef2ff;color:var(--brand);font-weight:600">${esc(g)} (${items.length})</td></tr>`;
    for(const j of items){
      const link = j.applyUrl ? `<a href="${esc(j.applyUrl)}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none" onclick="event.stopPropagation()">🔗 去投</a>` : '<span class="opt-in">—</span>';
      html += `<tr class="jobrow ${state.selectedJobId===j.id?'sel':''}" data-id="${esc(j.id)}">
        <td>${esc(j.company)}</td><td>${esc(j.title)}</td><td>${esc(j.industry||'')}</td>
        <td>${esc(j.workType||'')}</td><td>${esc(j.location||'')}</td><td class="mono" style="font-size:11px">${esc(j.updatedAt||'')}</td>
        <td class="${deadRank(j)===0?'w-yellow':''}">${esc(j.deadline||'')}</td>
        <td>${link}</td>
        <td><button class="btn btn-sm seljob" data-id="${esc(j.id)}">🧾 打开 JD</button></td></tr>`;
    }
  }
  html += `</tbody></table></div>`;
  return html;
}
function bindJobs(){
  const region=$('#jf-region'), work=$('#jf-work'), q=$('#jf-q');
  if(region) region.onchange=()=>{ state.jobFilter.region=region.value; refreshJobs(); };
  if(work) work.onchange=()=>{ state.jobFilter.workType=work.value; refreshJobs(); };
  if(q) q.oninput=()=>{ state.jobFilter.q=q.value; refreshJobs(); };
  const upd=$('#jobsUpdateBtn'); if(upd) upd.onclick=async()=>{
    toast('正在重新解析本地机会 Excel…'); const r=await API.importJobs({});
    if(r.ok){ state.resources.jobs=r.rows; toast('已更新 '+r.count+' 条','ok'); renderResume(); } else toast(r.error,'err');
  };
  const rfr=$('#jobsRefreshBtn'); if(rfr) rfr.onclick=()=>refreshJobs();
  $$('.jobrow').forEach(tr=>tr.onclick=()=>selectJob(tr.dataset.id));
  $$('.seljob').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openJdTab(b.dataset.id); });
  bindOnlineImport();
}
function bindOnlineImport(){
  const help=$('#oi-help'), snip=$('#oi-snippet'), toggle=$('#oi-toggle'), run=$('#oi-run');
  if(help) help.onclick=()=>{ const b=$('#oi-helpbox'); b.style.display = b.style.display==='none'?'block':'none'; };
  if(toggle) toggle.onclick=()=>{ const a=$('#oi-area'); a.style.display = a.style.display==='none'?'block':'none'; };
  if(snip) snip.onclick=()=>copyText(TABLE_SNIPPET,'已复制取表代码，去已登录页面 F12 控制台粘贴回车');
  if(run) run.onclick=async()=>{
    const text=$('#oi-paste').value; if(!text.trim()){toast('请先粘贴表格','err');return;}
    const rows=parsePastedJobs(text); if(!rows.length){toast('未解析到有效行，检查列名/表头','err');return;}
    const final=mergeJobs(rows);
    await API.store.put('jobs', final); state.resources.jobs=final;
    $('#oi-status').textContent=`解析 ${rows.length} 行，机会库现 ${final.length} 条`; toast('已导入','ok'); renderResume();
  };
}
function parsePastedJobs(text){
  const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].includes(',') && !lines[0].includes('，') ? ',' : null);
  const rows = lines.map(l=> sep? l.split(sep) : l.split(/\s+|\|/) ).filter(a=>a.length);
  const known=['公司','岗位','工作','职位','company','job','title','类型','industry','地点','location','截止','deadline','链接','url','link','报名'];
  let hi=rows.findIndex(r=>r.some(c=>known.some(k=>String(c).toLowerCase().includes(k.toLowerCase()))));
  if(hi===-1) hi=0;
  const head=rows[hi].map(h=>String(h).toLowerCase());
  const col=(needles)=>head.findIndex(h=>needles.some(n=>h.includes(n)));
  const iCompany=col(['公司名','公司']), iTitle=col(['岗位','职位','公告','position','title','job']), iType=col(['类型']), iIndustry=col(['行业']), iLoc=col(['地点','location']), iDead=col(['截止','deadline']), iUrl=col(['链接','url','link','报名']);
  const out=[];
  for(let r=hi+1;r<rows.length;r++){
    const a=rows[r]; const g=i=>i>=0?(a[i]||'').trim():'';
    const company=g(iCompany)||g(iTitle);
    if(!company) continue;
    out.push({ id:uid(), company: company.slice(0,60), title:g(iTitle)||g(iCompany), industry:g(iIndustry), workType:g(iType), location:g(iLoc), applyUrl:g(iUrl), applyMethod:g(iUrl)?'点击报名':'', updatedAt:new Date().toISOString().slice(0,10), deadline:normalizeDead(g(iDead)), source:'在线导入' });
  }
  return out;
}
function normalizeDead(v){ if(!v) return ''; if(/尽快|随时|招满|长期/.test(v)) return v; const m=String(v).match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/); return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:String(v); }
function mergeJobs(rows){ const cur=state.resources.jobs||[]; const seen=new Set(cur.map(j=>j.id)); return [...rows.filter(r=>!seen.has(r.id)), ...cur]; }
const TABLE_SNIPPET=`(()=>{const t=document.querySelector('table');if(!t){alert('未找到<table>，飞书Base请改用导出Excel');return;}let s=[];for(const tr of t.querySelectorAll('tr')){let c=[];for(const td of tr.querySelectorAll('td,th')){c.push((td.innerText||td.textContent||'').trim().replace(/\\s+/g,' '));}if(c.join(''))s.push(c.join('\\t'));}const txt=s.join('\\n');(navigator.clipboard?navigator.clipboard.writeText(txt):Promise.resolve()).then(()=>alert('已复制 '+s.length+' 行表格，去机会库「粘贴导入」粘贴'));})();`;
function refreshJobs(){ const t=$('#jobsTable'); if(t) t.innerHTML=jobsTableHtml(); bindJobs(); }
function selectJob(id){ state.selectedJobId=id; refreshJobs(); }
/* 从机会库某行跳到 JD 工作台并载入该岗位 */
function openJdTab(id){
  const j=(state.resources.jobs||[]).find(x=>x.id===id); if(!j){ toast('没找到该岗位','err'); return; }
  state.selectedJobId=id;
  state.jdEntry.jobId=id;
  state.jdEntry.company=j.company||'';
  state.jdEntry.title=j.title||'';
  state.jdEntry.url=j.applyUrl||'';
  if(!state.jdEntry.text && state.jds[id]) state.jdEntry.text=state.jds[id];
  saveJdEntry();
  state.resumeSub='jd'; renderResume();
  toast('已载入「'+j.company+' — '+j.title+'」','ok');
}

/* ---------- JD 工作台（独立页面，可手动填 / 从机会库载入） ---------- */
const JD_LS_KEY = 'jobapp.jdEntry';
function saveJdEntry(){ try{ localStorage.setItem(JD_LS_KEY, JSON.stringify(state.jdEntry)); }catch(e){} }
function loadJdEntry(){
  try{ const t=localStorage.getItem(JD_LS_KEY); if(t){ const o=JSON.parse(t); if(o&&typeof o==='object') state.jdEntry=Object.assign(state.jdEntry,o); } }catch(e){}
}
function jdPickList(){
  const q=(state.jdPickQ||'').trim().toLowerCase();
  const jobs=state.resources.jobs||[];
  const r = q ? jobs.filter(j=>(j.company+' '+j.title+' '+(j.location||'')+' '+(j.industry||'')).toLowerCase().includes(q)) : jobs;
  return r;
}
function renderJdWorkbench(){
  const e=state.jdEntry; const kind=e.kind||state.tailorKind||'zh';
  const list=jdPickList();
  const opts=list.slice(0,200).map(j=>`<option value="${esc(j.id)}" ${e.jobId===j.id?'selected':''}>${esc(j.company)} — ${esc(j.title)}${j.location?' · '+esc(j.location):''}</option>`).join('');
  const j=(state.resources.jobs||[]).find(x=>x.id===e.jobId);
  return `
  <div class="panel">
    <h4 class="panel-title">🧾 JD 工作台 <span class="opt-in">独立页面 · 手动粘贴 或 从机会库载入 · 只存本地浏览器</span></h4>
    <div class="row">
      <input id="jdQ" placeholder="搜机会库（公司 / 岗位 / 地点 / 行业）…" value="${esc(state.jdPickQ||'')}" style="max-width:260px" />
      <select id="jdPick" style="max-width:420px">${opts || '<option value="">（无匹配，可直接手动填写）</option>'}</select>
      <button class="btn" id="jdLoad">⬇ 载入到下方</button>
      <span class="opt-in">匹配 ${list.length} 条，下拉最多列 200 条</span>
    </div>
    <div class="hint" style="margin-top:8px">载入只会覆盖「公司 / 岗位 / 链接」，已粘贴的 JD 正文不会被清空。</div>
  </div>
  <div class="panel">
    <div class="row" style="margin-bottom:10px">
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px">公司名称
        <input id="jdCompany" placeholder="例：Manulife" value="${esc(e.company)}" style="min-width:220px" />
      </label>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px">岗位名称
        <input id="jdTitle" placeholder="例：Analyst Intern, Private Equity" value="${esc(e.title)}" style="min-width:280px" />
      </label>
    </div>
    ${j?`<div class="opt-in" style="margin-bottom:8px">来源机会库：行业 ${esc(j.industry||'-')} ｜ 类型 ${esc(j.workType||'-')} ｜ 更新 ${esc(j.updatedAt||'-')} ｜ 截止 ${esc(j.deadline||'-')}</div>`:''}
    <label>岗位链接（可选用「抓取链接」自动取正文）
      <div class="row" style="margin-top:4px">
        <input id="jdUrl" placeholder="https://…" value="${esc(e.url)}" style="flex:1;min-width:280px" />
        <button class="btn" id="jdFetch">🔗 抓取链接</button>
      </div>
    </label>
    <label style="margin-top:10px">岗位 JD / 描述（粘贴全文）
      <textarea id="jdText" rows="16" placeholder="把 JD 原文粘贴到这里…">${esc(e.text)}</textarea>
    </label>
    <div class="row" style="margin-top:10px">
      ${e.url?`<a href="${esc(e.url)}" target="_blank" rel="noopener" class="btn btn-accent" style="text-decoration:none">🔗 打开招聘页</a>`:''}
      <button class="btn" id="jdCopy">📋 复制 JD</button>
      <button class="btn" id="jdClear">🗑 清空</button>
      <div class="space"></div>
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px">输出语言
        <select id="jdKind" style="max-width:110px;padding:2px 4px">
          <option value="zh" ${kind==='zh'?'selected':''}>简体中文</option>
          <option value="tw" ${kind==='tw'?'selected':''}>繁體中文</option>
          <option value="en" ${kind==='en'?'selected':''}>英文</option>
        </select>
      </label>
      <button class="btn btn-primary" id="jdTailor">🎯 定制简历 → Claude Code</button>
    </div>
    <div class="hint" style="margin-top:8px">点「定制简历 → Claude Code」把「7 个 skill 指令 + 经历库路径 + 基础简历 + 本 JD」一起复制；粘贴到 Claude Code 后依次用 resume-evidence-workflow / tailored-resume-generator / resume-tailor / resume-ats-optimizer / resume-bullet-writer / resume-quantifier / resume-formatter 生成，结果粘回简历页存库。</div>
  </div>`;
}
function bindJdWorkbench(){
  const q=$('#jdQ');
  if(q) q.oninput=()=>{ state.jdPickQ=q.value; const sel=$('#jdPick'); const list=jdPickList(); sel.innerHTML=list.slice(0,200).map(j=>`<option value="${esc(j.id)}">${esc(j.company)} — ${esc(j.title)}${j.location?' · '+esc(j.location):''}</option>`).join('') || '<option value="">（无匹配）</option>'; };
  const load=$('#jdLoad'); if(load) load.onclick=()=>{
    const id=$('#jdPick') ? $('#jdPick').value : '';
    if(!id){ toast('先在下拉里选一条岗位','err'); return; }
    const j=(state.resources.jobs||[]).find(x=>x.id===id); if(!j){ toast('没找到该岗位','err'); return; }
    state.jdEntry.jobId=id;
    state.jdEntry.company=j.company||'';
    state.jdEntry.title=j.title||'';
    state.jdEntry.url=j.applyUrl||'';
    if(!state.jdEntry.text && state.jds[id]) state.jdEntry.text=state.jds[id];
    saveJdEntry(); renderResume(); toast('已载入「'+j.company+'」到 JD 工作台','ok');
  };
  const bind=(sel,key)=>{ const el=$(sel); if(el) el.oninput=()=>{ state.jdEntry[key]=el.value; if(key==='text'&&state.jdEntry.jobId) state.jds[state.jdEntry.jobId]=el.value; saveJdEntry(); }; };
  bind('#jdCompany','company'); bind('#jdTitle','title'); bind('#jdUrl','url'); bind('#jdText','text');
  const k=$('#jdKind'); if(k) k.onchange=()=>{ state.tailorKind=k.value; state.jdEntry.kind=k.value; saveJdEntry(); };
  const fetchBtn=$('#jdFetch'); if(fetchBtn) fetchBtn.onclick=async()=>{
    const url=($('#jdUrl')?$('#jdUrl').value:'').trim(); if(!url){ toast('请先填链接','err'); return; }
    toast('正在抓取…');
    const r=await API.fetchJd(url);
    if(r.ok){ state.jdEntry.text=r.text; state.jdEntry.url=url; if(state.jdEntry.jobId) state.jds[state.jdEntry.jobId]=r.text; saveJdEntry(); renderResume(); toast('已抓取 JD 正文','ok'); }
    else toast(r.error,'err');
  };
  const cp=$('#jdCopy'); if(cp) cp.onclick=()=>{ const t=state.jdEntry.text||''; if(!t.trim()){ toast('JD 为空','err'); return; } copyText(t,'已复制 JD'); };
  const cl=$('#jdClear'); if(cl) cl.onclick=()=>{ if(!confirm('清空当前 JD 工作台内容？（公司/岗位/链接/正文）')) return; state.jdEntry={jobId:'',company:'',title:'',url:'',text:''}; saveJdEntry(); renderResume(); toast('已清空'); };
  const tl=$('#jdTailor'); if(tl) tl.onclick=()=>copyJdToClaude();
}
function copyJdToClaude(){
  const e=state.jdEntry||{}; const txt=(e.text||'').trim();
  if(!txt){ toast('请先粘贴或抓取 JD 正文','err'); return; }
  const label=[e.company,e.title].filter(Boolean).join(' — ');
  copyText(buildTailorPrompt(state.tailorKind||'zh', txt, label), '定制提示词已复制，去 Claude Code 粘贴');
  toast('已复制 7-skill 定制提示词（含经历库路径）','ok');
}
/* 组装 7-skill 定制简历提示词（优先用经历库，而非只用基础简历） */
function buildTailorPrompt(kind, jdText, jobLabel){
  const defaults={zh:DEFAULT_ZH,tw:DEFAULT_TW,en:DEFAULT_EN};
  // 基础简历优先取「简历库」里的 type='base'（用户导入的完整母本），同语言优先，否则任一 base，最后才退回内置 DEFAULT_*
  const baseLib=(state.resources.resumes||[]).filter(r=>r.type==='base');
  const baseRes=baseLib.find(r=>r.kind===kind) || baseLib[0];
  const base=baseRes ? baseRes.content : ((state.baseResume[kind]!=null) ? state.baseResume[kind] : (defaults[kind]||DEFAULT_ZH));
  const langNote = kind==='en' ? '输出英文，用地道商务英文' : kind==='tw' ? '输出繁體中文，用词地道' : '输出简体中文';
  return `请为我定制一份求职简历，严格按下面流程执行，并优先使用我工作台「经历库」里的经历事实（不是只用基础简历的简化表述）。

【必读证据源】
- 经历库：job-app/data/store/material.json（每条经历含多方向写法、关键词、量化成果）
- 证据库：job-app/data/seed/证据库.md
- 基础简历：见下方【基础简历】

【执行流程（依次用到这些 skill）】
1. resume-evidence-workflow —— 读经历库盘点经历、解构 JD、建「需求→证据」匹配矩阵，选出最合适的简历 skill
2. tailored-resume-generator —— 分析 JD 生成定制简历骨架，突出匹配经历与转岗迁移点
3. resume-tailor —— 针对本 JD 精修，保持真实不编造
4. resume-ats-optimizer —— 提取 JD 关键词，做 ATS 关键词匹配与覆盖检查
5. resume-bullet-writer —— 弱 bullet 改成「动作 + 方法 + 量化结果」的成就式写法
6. resume-quantifier —— 补指标；缺精确数字时用合理估算并标注「约」
7. resume-formatter —— 做 ATS 友好排版（单栏、标准标题、无表格/图片/复杂格式）

【目标岗位】${jobLabel||''}

【岗位 JD】
${jdText}

【基础简历】
${base}

【输出要求】
- ${langNote}
- 直接输出定制后的完整简历文本
- 经历事实优先取自经历库的多方向写法与量化成果，而非基础简历的简化表述
- 不编造；新增估算数字标注「约」`;
}
function copyTailorPrompt(){
  const jd=(state.tailorJd||'').trim();
  if(!jd){ toast('请先粘贴 JD','err'); return; }
  const kind=state.tailorKind||'zh';
  copyText(buildTailorPrompt(kind, jd, ''), '定制提示词已复制，去 Claude Code 粘贴');
  toast('已复制 7-skill 定制提示词（含经历库路径）','ok');
}
function renderTailor(){
  const jd=state.tailorJd||''; const kind=state.tailorKind||'zh';
  return `<div class="panel">
    <h4 class="panel-title">🎯 定制简历 <span class="opt-in">不挑岗位库，直接粘贴 JD → 生成提示词 → 回 Claude Code 用 7 个简历 skill 定制</span></h4>
    <label>粘贴岗位 JD / 描述（你自己在招聘网站找到的原文）
      <textarea id="tailorJd" rows="9" placeholder="把 JD 全文粘贴到这里…" oninput="state.tailorJd=this.value">${esc(jd)}</textarea>
    </label>
    <div class="row" style="margin-top:10px">
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px">输出语言
        <select onchange="state.tailorKind=this.value" style="max-width:110px;padding:2px 4px">
          <option value="zh" ${kind==='zh'?'selected':''}>简体中文</option>
          <option value="tw" ${kind==='tw'?'selected':''}>繁體中文</option>
          <option value="en" ${kind==='en'?'selected':''}>英文</option>
        </select>
      </label>
      <div class="space"></div>
      <button class="btn btn-primary" onclick="copyTailorPrompt()">📋 生成提示词并复制</button>
    </div>
    <div class="hint" style="margin-top:8px">点「生成提示词」会组装「7 个 skill 指令 + 经历库路径 + JD + 基础简历」复制到剪贴板，去 Claude Code 粘贴即可定制。</div>
  </div>`;
}
function copyText(t,msg){ (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>toast(msg||'已复制','ok')).catch(()=>{ const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(msg||'已复制','ok'); }); }

/* ---------- 基础简历编辑 ---------- */
function baseResumeHtml(kind, def){
  const cur = state.baseResume[kind];
  const labels={zh:'中文简历（投深圳）',tw:'繁體中文（投香港）',en:'英文简历（投香港/外企）',cover:'Cover Letter（可选）'};
  const label=labels[kind]||kind;
  const content = cur!=null?cur:def;
  const view = (state.resumeView&&state.resumeView[kind])||'edit';
  return `<div class="panel">
    <h4 class="panel-title">📄 ${label} <span class="opt-in">参考你 2026 PDF 版式 · 单栏 ATS 友好 · 无照片无出生日期（港/外企规范）</span></h4>
    <div class="row" style="margin-bottom:10px">
      <button class="btn ${view==='preview'?'btn-primary':''}" onclick="toggleResumeView('${kind}','preview')">👁 预览</button>
      <button class="btn ${view==='edit'?'btn-primary':''}" onclick="toggleResumeView('${kind}','edit')">✎ 编辑</button>
      <div class="space"></div>
      <button class="btn" onclick="resetResume('${kind}')">↺ 默认</button>
      <button class="btn" onclick="polishResume('${kind}')">✨ AI 润色</button>
      <button class="btn" onclick="saveResumeToLib('${kind}')">💾 存库</button>
      <button class="btn btn-accent" onclick="exportResume('${kind}')">🖨 导出PDF</button>
    </div>
    ${view==='preview'
      ? `<div class="resume-preview" id="rv-${kind}">${renderResumePreview(content)}</div>`
      : `<textarea id="rs-${kind}" rows="22" oninput="onResumeInput('${kind}',this.value)" style="font-family:var(--mono);font-size:13px;line-height:1.6">${esc(content)}</textarea>`}
  </div>`;
}
function toggleResumeView(kind, view){ state.resumeView=state.resumeView||{}; state.resumeView[kind]=view; renderResume(); }
function onResumeInput(kind, val){ state.baseResume[kind]=val; }
function resetResume(kind){ state.baseResume[kind]=null; renderResume(); }
/* 把简历文本解析成设计化单栏 HTML（姓名/联系/分区/日期左右排/要点） */
function renderResumePreview(text){
  const secRe=/^(教育|工作|实习|技能|证书|项目|EDUCATION|WORK EXPERIENCE|WORK|INTERNSHIP|SKILL|CERTIFICAT|PROJECT|PROFESSIONAL|EXPERIENCE)/i;
  const dateRe=/(20\d\d(?:\.\d{1,2})?(?:[-\-–~]\s*20\d\d(?:\.\d{1,2})?)?)/;
  let html=''; let firstName=true;
  for(const raw of String(text||'').split('\n')){
    const t=raw.trimEnd(); if(!t.trim()){ html+='<div style="height:8px"></div>'; continue; }
    const tt=t.trim();
    if(firstName && !secRe.test(tt) && tt.length<30 && !dateRe.test(tt)){ html+=`<div class="rname rc-acc">${esc(tt)}</div>`; firstName=false; continue; }
    if(/@|linkedin\.com|Tel|电话/.test(tt) && tt.length<80){ html+=`<div class="rcontact">${esc(tt)}</div>`; continue; }
    if(secRe.test(tt) && tt.length<44){ html+=`<div class="rsec">${esc(tt)}</div>`; continue; }
    if(/^([•▪●]|[-–])\s*/.test(tt)){ html+=`<ul class="jps"><li>${esc(tt.replace(/^([•▪●]|[-–])\s*/,''))}</li></ul>`; continue; }
    const m=tt.match(/^(.*?)\s{2,}((?:20\d\d\.\d{1,2}[-\-–~]\d{4}\.\d{1,2})|(?:20\d\d[-\-–~]\d{4})|(?:[A-Z][a-z]{2}\s+\d{4}\s*[-\-–]\s*[A-Z][a-z]{2}\s*\d{4}))\s*$/);
    if(m){ html+=`<div class="rrow"><span><b>${esc(m[1].replace(/\s{2,}/g,' ').trim())}</b></span><span class="rdate">${esc(m[2])}</span></div>`; continue; }
    html+=`<div class="rsub">${esc(tt.replace(/\s{2,}/g,' '))}</div>`;
  }
  return html;
}
async function polishResume(kind){
  if(!state.config.hasKey){ toast('请先在设置配置API Key','err'); return; }
  const ta=$('#rs-'+kind); const cur=ta.value;
  const aims={zh:'投递深圳地区的中文简历，突出成果与量化、关键词匹配',tw:'投递香港的繁體中文简历，用词地道、突出量化成果与关键词匹配、不写照片与出生日期',en:'投递香港及外企的英文简历，无照片无出生日期，突出影响与量化',cover:'一封英文 cover letter，恳切自然、突出与目标岗位匹配'};
  const aim=aims[kind]||aims.cover;
  const prompt=`请润色下面这段简历/信，面向${aim}。要求：保留所有真实经历与事实，不编造；语言更专业、更精炼、更量化；中文用简体，英文用地道商务英文；直接输出润色后的完整文本。\n\n---\n${cur}`;
  toast('AI 正在润色…'); const out=await aiChat([{role:'user',content:prompt}]);
  if(out){ ta.value=out; state.baseResume[kind]=out; toast('已润色，可再手动修改','ok'); }
}
async function saveResumeToLib(kind){
  const ta=$('#rs-'+kind); const content=ta.value; state.baseResume[kind]=content;
  const title = kind==='zh'?'中文简历（深圳）':kind==='tw'?'繁體中文简历（香港）':kind==='en'?'英文简历（香港/外企）':'Cover Letter';
  await API.store.add('resumes', { kind, title, content, createdAt:new Date().toISOString() });
  toast('已保存到简历库','ok');
}
function exportResume(kind){
  const ta=$('#rs-'+kind);
  const content = ta ? ta.value : (state.baseResume[kind]||'');
  const body = renderResumePreview(content);
  const w=window.open('','_blank'); if(!w){toast('请允许弹窗','err');return;}
  const css=`.resume-preview{max-width:780px;margin:0 auto;line-height:1.5;font-family:Arial,'Microsoft YaHei',sans-serif}
  .resume-preview .rname{font-size:22px;font-weight:800;padding-bottom:8px;margin:0 0 6px;border-bottom:2px solid #3b5bdb;color:#3b5bdb}
  .resume-preview .rcontact{font-size:12.5px;color:#7a8494;margin:1px 0}
  .resume-preview .rsec{margin:16px 0 8px;font-size:13.5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;border-bottom:1px solid #e3e8f0;padding-bottom:4px}
  .resume-preview .rrow{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin:3px 0}
  .resume-preview .rrow b{font-weight:700}
  .resume-preview .rdate{white-space:nowrap;color:#6b7686;font-size:12px}
  .resume-preview .rsub{font-size:12.5px;color:#4a5568;margin:1px 0 3px}
  .resume-preview ul.jps{list-style:none;margin:4px 0 6px;padding:0}
  .resume-preview ul.jps li{font-size:12.5px;color:#2b3648;padding:2px 0 2px 14px;position:relative}
  .resume-preview ul.jps li::before{content:'•';position:absolute;left:0;color:#3b5bdb}
  @media print{.no-print{display:none}@page{margin:14mm}}`;
  w.document.write(`<html><head><meta charset="utf-8"><title>${kind==='cover'?'Cover Letter':'Resume'}</title><style>${css}</style></head><body>
    <div class="no-print" style="text-align:right;max-width:780px;margin:0 auto 8px"><button onclick="window.print()" style="padding:8px 16px">🖨 打印 / 存为 PDF</button></div>
    ${body}</body></html>`);
  w.document.close();
}

/* ============================================================
   📐 简历排版 —— 与「CV-Ji Ziyue 20260915 / CV-纪子悦 20260912」同版式
   文档结构：{ kind, name, contacts:[string], photo:url,
              sections:[ { title, rows:[ { t:'pair'|'bullet'|'text', l, r, b } ] } ] }
   t='pair' 左标题+右日期；t='bullet' 方点要点；t='text' 整段文字；b=0 取消加粗
   ============================================================ */

/* 版式 CSS：编辑器与导出 PDF 共用同一份，保证所见即所得 */
const CV_CSS = `
.cv{position:relative;width:210mm;min-height:297mm;box-sizing:border-box;background:#fff;color:#111;margin:0 auto;
  font-family:'Microsoft YaHei','PingFang SC','Hiragino Sans GB',Arial,sans-serif;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.cv-zh,.cv-tw{padding:16.25mm 13mm 12mm;font-size:8.2pt;line-height:1.372}
.cv-en{padding:11.9mm 8mm 12mm;font-size:9pt;line-height:1;font-family:Arial,Helvetica,'Microsoft YaHei',sans-serif}
.cv-head{margin-bottom:21.5pt}
.cv-name{text-align:center;font-weight:700;margin:0 0 4.5pt;line-height:1.372}
.cv-zh .cv-name,.cv-tw .cv-name{font-size:14.2pt;letter-spacing:1.5px}
.cv-en .cv-name{font-size:15pt;letter-spacing:.6px;line-height:1.2;margin-bottom:6.3pt}
.cv-contact{text-align:center;color:#222}
.cv-zh .cv-contact,.cv-tw .cv-contact{line-height:1.4634}
.cv-en .cv-contact{line-height:1.09}
.cv-sec{font-weight:700;padding:1.4pt 0 1.4pt 12pt;border-left:3pt solid #000;border-bottom:.9pt solid #000;
  font-size:9.8pt;line-height:1.4;margin:8.95pt 0 4.3pt}
.cv-en .cv-sec{font-size:10.5pt;margin:8.15pt 0 3.2pt}
.cv-row,.cv-bullet,.cv-text{margin-bottom:2.5pt}
.cv-en .cv-row,.cv-en .cv-bullet,.cv-en .cv-text{margin-bottom:1.5pt}
.cv-en .cv-head{margin-bottom:24.1pt}
.cv-row{display:flex;justify-content:space-between;align-items:baseline;gap:8pt}
.cv-row>.l{flex:1 1 auto;min-width:0;font-weight:700}
.cv-row.b0>.l{font-weight:400}
.cv-row>.r{flex:0 0 auto;white-space:nowrap;color:#333}
.cv-bullet{position:relative;padding-left:15pt}
.cv-bullet::before{content:'';position:absolute;left:3.7pt;top:.62em;width:3pt;height:3pt;background:#000}
.cv-bullet.bd,.cv-text.bd{font-weight:700}
.cv-photo{position:absolute;right:13mm;top:12mm;width:21mm;height:25.4mm;object-fit:cover;object-position:top center}
/* 编辑器专用 */
.cv-edit [contenteditable]:focus{outline:none;background:#eef3ff;border-radius:2px}
.cv-edit [contenteditable]:empty::before{content:attr(data-ph);color:#c2c8d2}
.cv-edit [contenteditable]:empty{min-width:60px}
.cv-wrap{position:relative;display:flow-root}
.cv-tools{position:absolute;right:100%;top:0;margin-right:5px;display:flex;gap:2px;white-space:nowrap;opacity:0;transition:.12s;z-index:3}
.cv-wrap:hover>.cv-tools{opacity:1}
.cv-tools button{border:1px solid #c9d2e3;background:#fff;color:#4a5568;font-size:10px;line-height:1;
  padding:3px 4px;border-radius:4px;cursor:pointer;font-family:inherit}
.cv-tools button:hover{background:#3b5bdb;color:#fff;border-color:#3b5bdb}
.cv-tools button.on{background:#3b5bdb;color:#fff;border-color:#3b5bdb}
`;
let _cvCssInjected = false;
function injectCvCss(){
  if(_cvCssInjected || document.getElementById('cv-style')) return;
  const s=document.createElement('style'); s.id='cv-style'; s.textContent=CV_CSS;
  document.head.appendChild(s); _cvCssInjected=true;
}

/* ---------- 内置版式模板（按 PDF 原文逐行还原） ---------- */
const CV_TPL_ZH = {
  kind:'zh', name:'纪子悦', photo:'/uploads/cv_photo.jpg',
  contacts:['电话： 13635260153 | 邮箱： sophiaji2001@gmail.com','领英： www.linkedin.com/in/ziyueji0806'],
  sections:[
    { title:'教育经历', rows:[
      { t:'pair', l:'香港大学 (HKU)-计算机科学(E-Commerce and Internet Computing) 硕士 全日制', r:'2026年09月 - 2027年11月' },
      { t:'bullet', l:'主要课程：电子商务技术、数字化转型、知识图谱、商业与电商机器学习、计算智能与机器学习' },
      { t:'pair', l:'香港浸会大学 (HKBU)-会计学 (一等荣誉学位) 本科 全日制', r:'2019年09月 - 2023年06月' },
      { t:'text', l:'GPA：3.62/4.00｜全校二等奖学金｜学生实习实践奖学金 | 十一届大学生电子商务“创新、创意及创业”挑战赛(广东省省赛二等奖)' }
    ]},
    { title:'工作经历', rows:[
      { t:'pair', l:'普华永道中天会计师事务所-高级审计员', r:'2023年10月 - 2026年09月' },
      { t:'text', l:'深耕金融、TMT及制造业领域，核心能力覆盖风险控制体系建设、估值建模、经营分析及复杂会计处理；熟练运用 Python、SQL、Power BI 等工具推动审计与财务分析流程自动化，提升项目执行效率。' },
      { t:'bullet', l:'金融资产估值：运用 DCF（FCFF/WACC）、可比公司法、Backsolve 等方法完成 20+ 项非上市股权投资公允价值验证；基于 Black-Scholes 模型执行 OPM 股权价值分配及 DLOM 测算；主导 20+ 只私募基金估值体系复核，覆盖 50+ 个直投项目，整体效率提升 40%。' },
      { t:'bullet', l:'内控体系：熟悉 SOX / C-SOX 内控要求，主导多行业全业务循环风险识别、穿行测试及控制测试；搭建制造业“生产—成本—存货”全流程内控体系，将成本差异核算精度提升至日度维度。' },
      { t:'bullet', l:'金融资产减值：主导 140 亿元存量信贷资产全量审阅，识别并预警 2 笔合计 2.4 亿元违约风险贷款；通过五级分类交叉验证实现 95%+ 评级准确率；搭建 IFRS 9 分类矩阵及多场景 DCF 减值模型，优化 IRB 内部评级参数（PD / LGD），推动拨备覆盖率提升 12 个百分点。' },
      { t:'bullet', l:'数据分析：基于 SQL 处理 10 万+ 条财务凭证，并设计五类高风险筛选规则，识别 150+ 笔异常交易，覆盖 56 家合并主体；通过 Python 抓取债券评级及利率数据，搭建估值基准数据库，效率提升 40%；运用 Stata 多元回归模型识别收入核心驱动因素。' },
      { t:'bullet', l:'合并报表与会计准则：负责多个集团合并报表编制，开发 VBA + SQL 自动化工具，批量处理千笔级公司间交易抵消，效率提升 50%；支持 IFRS / US GAAP 双准则合规披露；带队出具 10+ 份集团审计报告，覆盖 7 家子公司，识别多项会计处理及内控管理缺陷；熟悉新收入准则及金融工具准则，为多行业客户提供准则落地及会计处理优化方案。' }
    ]},
    { title:'项目经历', rows:[
      { t:'pair', l:'求职工作台 & 课程笔记 Agent Skill', r:'2026年09月' },
      { t:'bullet', l:'用 Claude Code 从 0 开发个人求职工作台（Node/Express 后端 + 单页前端），集成 DeepSeek LLM API 完成 JD 分析、经历润色、面试题生成，解析 1500+ 岗位 Excel 并支持 PDF 导出；' },
      { t:'bullet', l:'开发「课程笔记整理」Agent Skill，将港硕课件 PDF 分节生成中英双语课时页、逐行讲解算法、自动判分练习题（内嵌 Pyodide 可运行代码工作区），覆盖 5 门课程' }
    ]},
    { title:'实习经历', rows:[
      { t:'pair', l:'普华永道中天会计师事务所 | 审计实习生', r:'2022年01月 - 2022年03月' },
      { t:'text', l:'港股上市银行年度审计：负责 8+ 个科目审计（拆分明细、审计调整、变动分析、披露、测算/抽凭）；制作函证控制表，负责所有函证 200+' },
      { t:'pair', l:'华兴会计师事务所 | 审计实习生', r:'2021年06月 - 2021年09月' },
      { t:'text', l:'建筑工程公司净资产专项审计：参与六大往来款底稿，编制重分类调整分录，账龄复核，内部往来逐笔核对，制发往来款函证与抽凭；完成团队近 30% 基础性工作，获一致好评' },
      { t:'pair', l:'中国平安保险（集团）公司 | 客户经理助理', r:'2020年07月 - 2020年09月' },
      { t:'text', l:'入职培训考试 96 分（前 5%），带领 8 人团队获全班第一、"优秀团队"证书；协助讲师每日 3 例案例分析及 1-2 件产品介绍；任讲师助理，帮助近百位新人岗前培训，80%+ 通过结训考试' }
    ]},
    { title:'技能证书', rows:[
      { t:'bullet', l:'证书/执照： 微软MOS Excel专家级认证、微软MTA python国际认证、英语CET-6，CET-4' },
      { t:'bullet', l:'语言： 英语（IELTS 7.5 & 本硕全英教学），粤语（流利），普通话（母语）' },
      { t:'bullet', l:'技能： 熟练使用Office软件、SQL、Python、PowerBI' }
    ]}
  ]
};

const CV_TPL_TW = {
  kind:'tw', name:'紀子悅', photo:'/uploads/cv_photo.jpg',
  contacts:['電話： 13635260153 | 郵箱： sophiaji2001@gmail.com','領英： www.linkedin.com/in/ziyueji0806'],
  sections:[
    { title:'教育經歷', rows:[
      { t:'pair', l:'香港大學 (HKU)-計算機科學(E-Commerce and Internet Computing) 碩士 全日制', r:'2026年09月 - 2027年11月' },
      { t:'bullet', l:'主要課程：電子商務技術、數碼轉型、知識圖譜、商業與電商機器學習、計算智能與機器學習' },
      { t:'pair', l:'香港浸會大學 (HKBU)-會計學 (一級榮譽學位) 本科 全日制', r:'2019年09月 - 2023年06月' },
      { t:'text', l:'GPA：3.62/4.00｜全校二等獎學金｜學生實習實踐獎學金 | 十一屆大學生電子商務「創新、創意及創業」挑戰賽(廣東省省賽二等獎)' }
    ]},
    { title:'工作經歷', rows:[
      { t:'pair', l:'普華永道中天會計師事務所-高級審計員', r:'2023年10月 - 2026年09月' },
      { t:'text', l:'深耕金融、TMT及製造業領域，核心能力覆蓋風險控制體系建設、估值建模、經營分析及複雜會計處理；熟練運用 Python、SQL、Power BI 等工具推動審計與財務分析流程自動化，提升項目執行效率。' },
      { t:'bullet', l:'金融資產估值：運用 DCF（FCFF/WACC）、可比公司法、Backsolve 等方法完成 20+ 項非上市股權投資公允價值驗證；基於 Black-Scholes 模型執行 OPM 股權價值分配及 DLOM 測算；主導 20+ 隻私募基金估值體系覆核，覆蓋 50+ 個直投項目，整體效率提升 40%。' },
      { t:'bullet', l:'內控體系：熟悉 SOX / C-SOX 內控要求，主導多行業全業務循環風險識別、穿行測試及控制測試；搭建製造業「生產—成本—存貨」全流程內控體系，將成本差異核算精度提升至日度維度。' },
      { t:'bullet', l:'金融資產減值：主導 140 億元存量信貸資產全量審閱，識別並預警 2 筆合計 2.4 億元違約風險貸款；通過五級分類交叉驗證實現 95%+ 評級準確率；搭建 IFRS 9 分類矩陣及多場景 DCF 減值模型，優化 IRB 內部評級參數（PD / LGD），推動撥備覆蓋率提升 12 個百分點。' },
      { t:'bullet', l:'數據分析：基於 SQL 處理 10 萬+ 條財務憑證，並設計五類高風險篩選規則，識別 150+ 筆異常交易，覆蓋 56 家合併主體；通過 Python 抓取債券評級及利率數據，搭建估值基準數據庫，效率提升 40%；運用 Stata 多元回歸模型識別收入核心驅動因素。' },
      { t:'bullet', l:'合併報表與會計準則：負責多個集團合併報表編製，開發 VBA + SQL 自動化工具，批量處理千筆級公司間交易抵消，效率提升 50%；支持 IFRS / US GAAP 雙準則合規披露；帶隊出具 10+ 份集團審計報告，覆蓋 7 家子公司，識別多項會計處理及內控管理缺陷；熟悉新收入準則及金融工具準則，為多行業客戶提供準則落地及會計處理優化方案。' }
    ]},
    { title:'項目經歷', rows:[
      { t:'pair', l:'求職工作台 & 課程筆記 Agent Skill', r:'2026年09月' },
      { t:'bullet', l:'用 Claude Code 從 0 開發個人求職工作台（Node/Express 後端 + 單頁前端），集成 DeepSeek LLM API 完成 JD 分析、經歷潤色、面試題生成，解析 1500+ 崗位 Excel 並支持 PDF 導出；' },
      { t:'bullet', l:'開發「課程筆記整理」Agent Skill，將港碩課件 PDF 分節生成中英雙語課時頁、逐行講解算法、自動判分練習題（內嵌 Pyodide 可運行代碼工作區），覆蓋 5 門課程' }
    ]},
    { title:'實習經歷', rows:[
      { t:'pair', l:'普華永道中天會計師事務所 | 審計實習生', r:'2022年01月 - 2022年03月' },
      { t:'text', l:'港股上市銀行年度審計：負責 8+ 個科目審計（拆分明細、審計調整、變動分析、披露、測算/抽憑）；製作函證控制表，負責所有函證 200+' },
      { t:'pair', l:'華興會計師事務所 | 審計實習生', r:'2021年06月 - 2021年09月' },
      { t:'text', l:'建築工程公司淨資產專項審計：參與六大往來款底稿，編製重分類調整分錄，帳齡覆核，內部往來逐筆核對，製發往來款函證與抽憑；完成團隊近 30% 基礎性工作，獲一致好評' },
      { t:'pair', l:'中國平安保險（集團）公司 | 客戶經理助理', r:'2020年07月 - 2020年09月' },
      { t:'text', l:'入職培訓考試 96 分（前 5%），帶領 8 人團隊獲全班第一、「優秀團隊」證書；協助講師每日 3 例案例分析及 1-2 件產品介紹；任講師助理，幫助近百位新人崗前培訓，80%+ 通過結訓考試' }
    ]},
    { title:'技能證書', rows:[
      { t:'bullet', l:'證書/執照： 微軟MOS Excel專家級認證、微軟MTA python國際認證、英語CET-6，CET-4' },
      { t:'bullet', l:'語言： 英語（IELTS 7.5 & 本碩全英教學），粵語（流利），普通話（母語）' },
      { t:'bullet', l:'技能： 熟練使用Office軟件、SQL、Python、PowerBI' }
    ]}
  ]
};

const CV_TPL_EN = {
  kind:'en', name:'JI Ziyue (Sophia)', photo:'',
  contacts:['+852 51451636 | sophiaji2001@gmail.com','www.linkedin.com/in/ziyueji0806'],
  sections:[
    { title:'EDUCATION', rows:[
      { t:'pair', l:'The University of Hong Kong (HKU)', r:'Sep 2026 - Nov 2027' },
      { t:'pair', l:'MSc in E-Commerce and Internet Computing | Full-time', r:'Hongkong', b:0 },
      { t:'bullet', l:'Relevant coursework: E-commerce Technology, Knowledge Graphs, Machine Learning for Business & E-Commerce, Computational Intelligence & Machine Learning' },
      { t:'pair', l:'Hong Kong Baptist University (HKBU)', r:'Sep 2019 - Jun 2023' },
      { t:'pair', l:'BBA in Accounting(First Class Honours) | Full-time', r:'Zhuhai', b:0 },
      { t:'text', l:'GPA:3.62/4.00 | School Second Class Scholarship | Student Internship Practice Scholarship | The 11th National College Students\' E-commerce "Innovation, Creativity and Entrepreneurship" Challenge (2nd Prize, Guangdong Provincial Round)' }
    ]},
    { title:'PROFESSIONAL EXPERIENCE', rows:[
      { t:'pair', l:'PricewaterhouseCoopers (PwC) Zhong Tian LLP Shenzhen Branch', r:'Oct 2023 - Sep 2026' },
      { t:'pair', l:'Senior Auditor', r:'Shenzhen', b:0 },
      { t:'text', l:'Covered financial services, TMT and manufacturing sectors, with focus on risk control, valuation modelling, business analysis and accounting treatments; applied Python, SQL and Power BI to automate audit procedures and improve efficiency.' },
      { t:'bullet', l:'Financial Asset Valuation: Performed fair value validation for 20+ unlisted equity investments using DCF, FCFF/WACC, comparable company analysis and backsolve methods; applied Black-Scholes for OPM equity allocation and DLOM estimation; led valuation framework reviews for 20+ private equity funds covering 50+ direct investments, improving efficiency by 40%.' },
      { t:'bullet', l:'Internal Control: Proficient in SOX and C-SOX; led risk identification, walkthroughs and control testing across full business cycles in multiple industries; built an end-to-end manufacturing internal control framework covering production, costing and inventory, improving cost variance calculation to daily granularity.' },
      { t:'bullet', l:'Financial Asset Impairment: Led full-scope review of RMB 14 billion credit assets, flagged two default-risk loans totaling RMB 240 million, and cross-validated five-category loan classification with 95%+ rating accuracy; built IFRS 9 classification matrix and multi-scenario DCF impairment model, optimized IRB rating assumptions including PD/LGD, and increased provision coverage by 12 percentage points.' },
      { t:'bullet', l:'Data Analytics: Processed 100,000+ journal entries using SQL and five high-risk screening rules, identifying 150+ abnormal transactions across 56 consolidated entities; built a Python-scraped bond rating and interest rate valuation benchmark database, improving benchmarking efficiency by 40%; used Stata multiple regression to identify key revenue drivers.' },
      { t:'bullet', l:'Consolidation & Accounting Standards: Prepared consolidated financial statements for multiple groups; developed VBA + SQL automation tools to batch-process thousands of intercompany eliminations, improving efficiency by 50%; supported IFRS / US GAAP dual-compliance disclosures; led teams to issue 10+ group audit reports covering seven subsidiaries, identified accounting and internal control deficiencies, and provided implementation and optimization solutions for revenue recognition and financial instruments standards across industries.' }
    ]},
    { title:'PROJECT EXPERIENCE', rows:[
      { t:'pair', l:'Job Application Workspace & Course Notes Agent Skill', r:'' },
      { t:'bullet', l:'Built a personal job application workspace from scratch with Claude Code, Node.js / Express backend and single-page frontend; integrated DeepSeek LLM API for JD analysis, resume bullet refinement and interview question generation; parsed 1,500+ job postings from Excel files and supported PDF export.' },
      { t:'bullet', l:'Developed a “Course Notes Organization” Agent Skill to convert postgraduate course PDFs into structured bilingual lesson pages in English and Chinese, with line-by-line algorithm explanations, auto-graded exercises and an embedded Pyodide-powered runnable coding workspace, covering five courses.' }
    ]},
    { title:'Internship experience', rows:[
      { t:'pair', l:'PricewaterhouseCoopers (PwC) Zhong Tian LLP Shenzhen Branch', r:'Jan 2022 - Mar 2022' },
      { t:'pair', l:'Audit Intern', r:'Shenzhen', b:0 },
      { t:'bullet', l:'Participated in the annual audit of an H-share listed bank; performed audit procedures for 8+ accounts, including breakdown schedules, audit adjustments, fluctuation analysis, disclosure review, recalculation and vouching; prepared confirmation control sheets and managed 200+ confirmations.' },
      { t:'pair', l:'Huaxing Certified Public Accountants', r:'Jun 2021 - Sep 2021' },
      { t:'pair', l:'Audit Intern', r:'Fuzhou', b:0 },
      { t:'bullet', l:'Participated in a special net asset audit for a construction engineering company; prepared working papers for six categories of receivables and payables, drafted reclassification entries, reviewed ageing schedules, reconciled intercompany balances line by line, and prepared confirmations and vouching; completed nearly 30% of the team’s foundational audit work and received strong recognition.' },
      { t:'pair', l:'Ping An Insurance (Group) Company of China', r:'Jul 2020 - Sep 2020' },
      { t:'pair', l:'Assistant Client Manager', r:'Fuzhou', b:0 },
      { t:'bullet', l:'Scored 96 in onboarding training, ranking top 5%; led an eight-member team to first place and received the “Outstanding Team” certificate; assisted trainers with three case analyses and one to two product briefings daily; supported pre-job training for nearly 100 new hires, achieving an 80%+ final exam pass rate.' }
    ]},
    { title:'Skills certificate', rows:[
      { t:'bullet', l:'Certifications: Microsoft MOS Excel expert certification, Microsoft MTA python international certification, English CET-6,CET-4' },
      { t:'bullet', l:'Languages: English (IELTS 7.5 & English), Cantonese (fluent), Mandarin (mother tongue)' },
      { t:'bullet', l:'Skills: Familiar with Office software, SQL, Python, PowerBI, Wind Terminal, Node.js / Express, LLM API Integration, Pyodide' }
    ]}
  ]
};

const CV_TPL = { zh: CV_TPL_ZH, tw: CV_TPL_TW, en: CV_TPL_EN };

/* ---------- 文档读写 ---------- */
function cvDoc(){
  const k = state.cvKind || 'zh';
  if(!state.cvDocs) state.cvDocs = {};
  if(!state.cvDocs[k]) state.cvDocs[k] = JSON.parse(JSON.stringify(CV_TPL[k] || CV_TPL.zh));
  return state.cvDocs[k];
}
/* 路径写法：n=姓名，c0=第0条联系方式，s0.t=分区标题，s0.r2.l / s0.r2.r = 第2行左/右栏 */
function cvSetPath(p, val){
  val = (val==null?'':String(val)).replace(/[\s\u00a0]*\n+[\s\u00a0]*/g, ' ');
  const d = cvDoc(), seg = String(p).split('.');
  if(seg[0]==='n'){ d.name = val; return; }
  if(seg[0][0]==='c'){ d.contacts[+seg[0].slice(1)] = val; return; }
  if(seg[0][0]==='s'){
    const s = d.sections[+seg[0].slice(1)]; if(!s) return;
    if(seg[1]==='t'){ s.title = val; return; }
    if(seg[1] && seg[1][0]==='r'){ const r = s.rows[+seg[1].slice(1)]; if(r && seg[2]){ r[seg[2]] = val; } }
  }
}
/* 把结构化文档摊平成纯文本（存入简历库 / 供定制简历提示词使用） */
function cvToText(d){
  const out = [d.name || ''];
  (d.contacts||[]).forEach(c=>out.push(c));
  (d.sections||[]).forEach(s=>{
    out.push('', s.title || '');
    (s.rows||[]).forEach(r=>{
      const t = (r.l==null?'':r.l);
      if(r.t==='pair'){ out.push(t + (r.r ? '    '+r.r : '')); }
      else if(r.t==='bullet'){ out.push('• '+t); }
      else { out.push(t); }
    });
  });
  return out.join('\n');
}

/* ---------- 渲染 ---------- */
function cvField(path, text, cls, edit, ph){
  const attr = edit ? ` contenteditable="true" data-p="${path}" data-ph="${esc(ph||'…')}"` : '';
  return `<div class="${cls}"${attr}>${esc(text)}</div>`;
}
/* 该行当前是否加粗：pair 默认加粗（b=0 取消），bullet/text 默认常规（b=1 加粗） */
function cvBold(r){ return r.t==='pair' ? r.b!==0 : r.b===1; }
function cvRender(d, edit, photoSrc){
  const tools = (acts)=> edit ? `<div class="cv-tools" contenteditable="false">${acts}</div>` : '';
  let h = '';
  if(photoSrc) h += `<img class="cv-photo" src="${esc(photoSrc)}" alt="">`;
  h += `<div class="cv-head">`;
  h += `<div class="cv-wrap">${tools('<button data-act="addcontact">＋联系</button>')}${cvField('n', d.name, 'cv-name', edit, '姓名')}</div>`;
  (d.contacts||[]).forEach((c,i)=>{
    h += `<div class="cv-wrap">${tools(`<button data-act="delcontact" data-i="${i}">🗑</button>`)}${cvField('c'+i, c, 'cv-contact', edit, '联系方式')}</div>`;
  });
  h += `</div>`;
  (d.sections||[]).forEach((s,si)=>{
    h += `<div class="cv-wrap">${tools(
      `<button data-act="addrow" data-t="pair" data-s="${si}" data-i="-1">＋行</button>`+
      `<button data-act="addrow" data-t="bullet" data-s="${si}" data-i="-1">＋•要点</button>`+
      `<button data-act="secup" data-s="${si}">↑</button>`+
      `<button data-act="secdown" data-s="${si}">↓</button>`+
      `<button data-act="delsec" data-s="${si}">🗑</button>`)}`
      + cvField('s'+si+'.t', s.title, 'cv-sec', edit, '分区标题') + `</div>`;
    (s.rows||[]).forEach((r,ri)=>{
      const bt = `<button data-act="addrow" data-t="pair" data-s="${si}" data-i="${ri}">＋</button>`
        + `<button data-act="addrow" data-t="bullet" data-s="${si}" data-i="${ri}">•</button>`
        + `<button data-act="bold" data-s="${si}" data-i="${ri}" class="${cvBold(r)?'on':''}">B</button>`
        + `<button data-act="delrow" data-s="${si}" data-i="${ri}">🗑</button>`;
      if(r.t==='pair'){
        h += `<div class="cv-wrap">${tools(bt)}<div class="cv-row${cvBold(r)?'':' b0'}">`
          + cvField('s'+si+'.r'+ri+'.l', r.l, 'l', edit, '职位 / 公司')
          + cvField('s'+si+'.r'+ri+'.r', r.r, 'r', edit, '日期')
          + `</div></div>`;
      } else if(r.t==='bullet'){
        h += `<div class="cv-wrap">${tools(bt)}${cvField('s'+si+'.r'+ri+'.l', r.l, 'cv-bullet'+(cvBold(r)?' bd':''), edit, '要点')}</div>`;
      } else {
        h += `<div class="cv-wrap">${tools(bt)}${cvField('s'+si+'.r'+ri+'.l', r.l, 'cv-text'+(cvBold(r)?' bd':''), edit, '正文')}</div>`;
      }
    });
  });
  if(edit) h += `<div class="row" style="margin-top:14pt;justify-content:center;gap:8px">
    <button class="btn btn-sm" data-act="addsec">＋ 新增分区</button>
    <button class="btn btn-sm" data-act="addrow" data-t="pair" data-s="-1" data-i="-1">＋ 条目行</button>
    <button class="btn btn-sm" data-act="addrow" data-t="bullet" data-s="-1" data-i="-1">＋ • 要点行</button></div>`;
  return h;
}

/* ---------- 面板 ---------- */
function cvHtml(){
  injectCvCss();
  const kind = state.cvKind || 'zh';
  const view = state.cvView || 'edit';
  const d = cvDoc();
  const lib = state.resources.resumes||[];
  const kindLabel = { zh:'简体中文（深圳）', tw:'繁體中文（香港）', en:'English（香港/外企）' }[kind] || kind;
  return `<div class="panel">
    <h4 class="panel-title">📐 简历排版 <span class="opt-in">与「CV-Ji Ziyue 20260915 / CV-纪子悦 20260912」同版式 · 点任意文字直接改</span></h4>
    <div class="row" style="margin-bottom:8px">
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0">版式语言
        <select id="cv-kind" style="max-width:190px;padding:4px 6px">
          <option value="zh" ${kind==='zh'?'selected':''}>简体中文（深圳）</option>
          <option value="tw" ${kind==='tw'?'selected':''}>繁體中文（香港）</option>
          <option value="en" ${kind==='en'?'selected':''}>English（香港/外企）</option>
        </select>
      </label>
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0">从简历库载入
        <select id="cv-lib" style="max-width:240px;padding:4px 6px">
          <option value="">— 选择 —</option>
          ${lib.map((r,i)=>`<option value="${i}">${esc((r.type==='base'?'[基础] ':'[定制] ')+(r.title||r.kind||'简历'))}</option>`).join('')}
        </select>
      </label>
      <button class="btn btn-sm" onclick="cvLoadFromLib()">⬇ 载入</button>
      <button class="btn btn-sm" onclick="cvLoadFromText('${kind}')">⌨ 按文本重排</button>
      <button class="btn btn-sm" onclick="cvReset()">↺ 恢复默认模板</button>
      <div class="space"></div>
      <button class="btn btn-sm" onclick="cvPickPhoto()">📷 换照片</button>
      ${d.photo?`<button class="btn btn-sm" onclick="cvClearPhoto()">🖼 去照片</button>`:''}
      <input type="file" id="cv-photo-file" accept="image/*" style="display:none">
      <button class="btn btn-sm ${view==='edit'?'btn-primary':''}" onclick="cvSetView('edit')">✎ 编辑</button>
      <button class="btn btn-sm ${view==='preview'?'btn-primary':''}" onclick="cvSetView('preview')">👁 预览</button>
    </div>
    <div class="row" style="margin-bottom:12px">
      <button class="btn btn-primary" onclick="cvSave()">💾 保存</button>
      <button class="btn btn-accent" onclick="cvExportPdf()">🖨 导出 PDF（可重命名并入库）</button>
      <span class="hint" id="cv-engine"></span>
    </div>
    ${view==='preview'?'<div class="hint" style="margin-bottom:8px">预览模式：文字不可编辑。切换「✎ 编辑」即可直接点击修改任意文字。</div>':''}
    <div class="cv-stage" style="background:#eef0f4;padding:18px;border-radius:12px;overflow:auto">
      <div class="cv cv-${kind}${view==='edit'?' cv-edit':''}" id="cv-page" style="box-shadow:0 6px 26px rgba(28,36,48,.14)">${cvRender(d, view==='edit', d.photo)}</div>
    </div>
    <div class="hint" style="margin-top:10px">当前版式：${esc(kindLabel)} · 页面 210×297mm（A4，0 页边距）· 「导出 PDF」调用本机 Chrome 无头打印，产出真 PDF 文件，文件名即入库名。</div>
  </div>`;
}

function bindCv(){
  const page = $('#cv-page'); if(!page) return;
  if((state.cvView||'edit')==='edit'){
    $$('[data-p]', page).forEach(el=>{
      el.addEventListener('input', ()=> cvSetPath(el.dataset.p, el.innerText));
      el.addEventListener('keydown', e=>{
        if(e.key==='Enter'){ e.preventDefault(); }
        else if(e.key==='Backspace' && !el.innerText.trim()){ e.preventDefault(); }
      });
      el.addEventListener('paste', e=>{
        e.preventDefault();
        const t = ((e.clipboardData||window.clipboardData).getData('text/plain')||'').replace(/\s*\n+\s*/g,' ');
        document.execCommand('insertText', false, t);
      });
    });
    $$('[data-act]', page).forEach(b=> b.onmousedown = ev=>{ ev.preventDefault(); cvAct(b); });
  }
  const kindSel = $('#cv-kind'); if(kindSel) kindSel.onchange = ()=>{ state.cvKind = kindSel.value; renderResume(); };
  const pf = $('#cv-photo-file'); if(pf) pf.onchange = ()=> cvUploadPhoto(pf);
  API.pdfEngine().then(r=>{ const el=$('#cv-engine'); if(el) el.textContent = r && r.ok ? ('✅ 可用 '+r.engine+' 导出真 PDF') : '⚠ 未找到 Chrome/Edge，导出 PDF 不可用。请安装 Chrome 或 Edge 后重启服务'; });
}

/* ---------- 结构编辑 ---------- */
function cvAct(btn){
  const d = cvDoc();
  const act = btn.dataset.act;
  const si = +btn.dataset.s, ri = +btn.dataset.i;
  const s = d.sections[si];
  if(act==='addcontact'){ d.contacts.push('新的联系方式'); }
  else if(act==='delcontact'){ d.contacts.splice(ri,1); }
  else if(act==='addsec'){ d.sections.push({ title:'新分区', rows:[{ t:'text', l:'' }] }); }
  else if(act==='delsec'){ if(!confirm('删除分区「'+(s.title||'')+'」及其全部内容？')) return; d.sections.splice(si,1); }
  else if(act==='secup' && si>0){ d.sections.splice(si-1,0,d.sections.splice(si,1)[0]); }
  else if(act==='secdown' && si<d.sections.length-1){ d.sections.splice(si+1,0,d.sections.splice(si,1)[0]); }
  else if(act==='addrow'){
    const t = btn.dataset.t==='bullet' ? 'bullet' : 'pair';
    const row = t==='bullet' ? { t:'bullet', l:'新要点' } : { t:'pair', l:'新条目', r:'' };
    if(si < 0){  // 底部按钮：追加到最后一个分区
      const last = d.sections[d.sections.length-1];
      if(!last){ d.sections.push({ title:'新分区', rows:[row] }); }
      else { last.rows.push(row); }
    } else {
      s.rows.splice(ri+1, 0, row);
    }
  }
  else if(act==='delrow'){ s.rows.splice(ri,1); }
  else if(act==='bold'){ const r=s.rows[ri]; r.b = cvBold(r) ? 0 : 1; }
  renderResume();
}

function cvSetView(v){ state.cvView=v; renderResume(); }
function cvSwitchKind(k){ state.cvKind=k; renderResume(); }
function cvReset(){
  const k = state.cvKind||'zh';
  if(!confirm('恢复「'+(k)+'」版式的内置默认模板？当前未保存的改动会丢失。')) return;
  if(state.cvDocs) delete state.cvDocs[k];
  renderResume(); toast('已恢复默认模板','ok');
}
/* 用「简历库里的基础简历」或内置默认文本重新排版 */
function cvLoadFromText(kind){
  kind = kind || state.cvKind || 'zh';
  const defaults = { zh:DEFAULT_ZH, tw:DEFAULT_TW, en:DEFAULT_EN };
  const lib = ((state.resources||{}).resumes||[]);
  const src = lib.find(r=>r.type==='base' && r.kind===kind) || lib.find(r=>r.kind===kind);
  const text = src ? src.content : (defaults[kind]||DEFAULT_ZH);
  const from = src ? ('简历库「'+(src.title||kind)+'」') : ('内置'+kind+'默认文本');
  if(!confirm('用 '+from+' 重新排版？\n（会覆盖当前排版，未保存的改动丢失。文本越规整、标题与日期用空格分开，效果越好）')) return;
  if(state.cvDocs) state.cvDocs[kind] = cvFromText(text, kind);
  state.cvKind = kind; renderResume(); toast('已按文本重排（来自 '+from+'）','ok');
}
function cvLoadFromLib(){
  const sel = $('#cv-lib'); if(!sel || sel.value===''){ toast('先选一份简历','err'); return; }
  const r = (state.resources.resumes||[])[+sel.value]; if(!r) return;
  const kind = r.kind || state.cvKind || 'zh';
  if(!confirm('用「'+(r.title||'简历')+'」重新排版？当前未保存的改动会丢失。')) return;
  if(state.cvDocs) state.cvDocs[kind] = cvFromText(r.content||'', kind);
  state.cvKind = kind; renderResume(); toast('已载入并重新排版','ok');
}
/* 纯文本 → 结构化文档（尽力而为：靠分区标题 / 行尾日期 / 行首圆点切分） */
function cvFromText(text, kind){
  const SEC = /^(教育|工作|实习|技能|证书|项目|获奖|校园|研究|教育經歷|工作經歷|實習|技能|證書|項目|獲獎|EDUCATION|WORK|INTERNSHIP|SKILL|CERTIFICAT|PROJECT|PROFESSIONAL|EXPERIENCE|LEADERSHIP|ACTIVITIES|AWARDS)/i;
  const DATE = /^(?=.*(?:19|20)\d{2})(?:[0-9]{4}\s?[.\-\/年]\s?[0-9]{0,2}月?\s*(?:[-–—~至]|to)\s*[0-9]{0,4}\s?[.\-\/年]?\s?[0-9]{0,2}月?|[0-9]{4}\s?年?(?:\s*[-–—~至]\s*(?:[0-9]{4}\s?年?|至今|Present|now))?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}\s*(?:[-–—~]|to)\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}|Present|now|至今)|至今|Present|Now)$/i;
  const doc = { kind, name:'', contacts:[], photo:'', sections:[] };
  let cur = null, first = true;
  for(const raw of String(text||'').split('\n')){
    const line = raw.replace(/\t/g,' ').replace(/\s+$/,'');
    const t = line.trim();
    if(!t) continue;
    if(first){ doc.name = t; first = false; continue; }
    if(!cur && /@|linkedin/i.test(t)){ doc.contacts.push(t); continue; }
    if(SEC.test(t) && t.length<=30 && !/[。；]$/.test(t)){
      cur = { title:t, rows:[] }; doc.sections.push(cur); continue;
    }
    if(!cur){ doc.contacts.push(t); continue; }
    if(/^([•▪●·]|[-–—]\s)/.test(t)){ cur.rows.push({ t:'bullet', l:t.replace(/^([•▪●·]|[-–—])\s*/,'') }); continue; }
    const m = t.match(/^(.*?)\s{2,}(\S.*)$/);
    if(m && DATE.test(m[2].trim())){
      cur.rows.push({ t:'pair', l:m[1].trim(), r:m[2].trim() }); continue;
    }
    cur.rows.push({ t:'text', l:t });
  }
  if(!doc.name) doc.name = '姓名';
  if(!doc.contacts.length) doc.contacts.push('电话 / 邮箱');
  if(!doc.sections.length) doc.sections.push({ title:'经历', rows:[{ t:'text', l:'' }] });
  return doc;
}

/* ---------- 保存 / 导出 ---------- */
async function cvSave(){
  const k = state.cvKind||'zh';
  try{
    const arr = await API.store.get('cv');
    const list = Array.isArray(arr)?arr:[];
    const doc = cvDoc();
    const i = list.findIndex(x=>x.kind===k);
    const item = { id:'cv-'+k, kind:k, title:'排版简历·'+k, doc, updatedAt:new Date().toISOString() };
    if(i>=0) list[i] = item; else list.push(item);
    const r = await API.store.put('cv', list);
    if(r && r.ok) toast('已保存到 data/store/cv.json','ok'); else toast('保存失败：'+((r&&r.error)||''),'err');
  }catch(e){ toast('保存失败：'+e.message,'err'); }
}
async function cvLoadSaved(){
  try{
    const arr = await API.store.get('cv');
    if(!Array.isArray(arr)) return;
    state.cvDocs = state.cvDocs || {};
    arr.forEach(x=>{ if(x && x.kind && x.doc) state.cvDocs[x.kind] = x.doc; });
  }catch(e){}
}
function cvDefaultName(d){
  const t = new Date();
  const p = n=>String(n).padStart(2,'0');
  return 'CV-' + (d.name||'Resume').replace(/\s+/g,'') + ' ' + t.getFullYear() + p(t.getMonth()+1) + p(t.getDate());
}
async function cvToDataUri(url){
  try{
    const r = await fetch(url); const b = await r.blob();
    return await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=()=>res(''); fr.readAsDataURL(b); });
  }catch(e){ return ''; }
}
async function cvStandaloneHtml(){
  const d = cvDoc();
  const photo = d.photo ? await cvToDataUri(d.photo) : '';
  const lang = d.kind==='en' ? 'en' : (d.kind==='tw' ? 'zh-Hant' : 'zh-Hans');
  return '<!DOCTYPE html>\n<html lang="'+lang+'">\n<head>\n<meta charset="utf-8">\n<title>'+esc(d.name||'Resume')+'</title>\n<style>\n'
    + '@page{size:A4;margin:0}\nhtml,body{margin:0;padding:0;background:#fff}\n' + CV_CSS
    + '\n</style>\n</head>\n<body>\n<div class="cv cv-' + (d.kind||'zh') + '">' + cvRender(d, false, photo) + '</div>\n</body>\n</html>';
}
function downloadBlob(blob, name){
  const a = document.createElement('a');
  const u = URL.createObjectURL(blob);
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(u); a.remove(); }, 1500);
}
async function cvExportPdf(){
  if(state.cvBusy){ toast('正在导出，请稍候…'); return; }
  const d = cvDoc();
  const def = cvDefaultName(d);
  const input = prompt('PDF 文件名（不含 .pdf）\n导出后会以这个名字自动放进「简历库」；文件同时保存到你的下载文件夹。', def);
  if(input===null) return;
  const fname = (input.trim() || def);
  state.cvBusy = true;
  toast('正在调用本机 Chrome 生成 PDF…（约 3-8 秒）');
  try{
    const html = await cvStandaloneHtml();
    const r = await API.renderPdf(html);
    if(!r || r.error || !r.pdfBase64){ toast('导出失败：'+((r&&r.error)||'未知错误'),'err'); return; }
    const bin = atob(r.pdfBase64);
    const u8 = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
    downloadBlob(new Blob([u8], {type:'application/pdf'}), fname+'.pdf');
    const add = await API.store.add('resumes', {
      kind: d.kind, title: fname, type:'tailored', source:'HTML排版导出',
      fileName: fname+'.pdf', bytes: u8.length, content: cvToText(d),
      createdAt: new Date().toISOString()
    });
    try { state.resources.resumes = await API.store.get('resumes'); } catch(e){}
    toast('已导出 ' + fname + '.pdf（' + Math.round(u8.length/1024) + ' KB），并已放入简历库', 'ok');
  } finally { state.cvBusy = false; }
}
function cvPickPhoto(){ const f=$('#cv-photo-file'); if(f) f.click(); }
function cvClearPhoto(){ cvDoc().photo=''; renderResume(); }
async function cvUploadPhoto(input){
  const f = input.files && input.files[0]; if(!f) return;
  if(f.size > 8*1024*1024){ toast('照片过大（>8MB），请压缩后重试','err'); return; }
  const b64 = await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
  const r = await API.uploadImage({ filename:f.name, fileBase64:b64 });
  if(!r || r.error){ toast('上传失败：'+((r&&r.error)||''),'err'); return; }
  cvDoc().photo = r.url; renderResume(); toast('照片已更新','ok');
}

/* ---------- 简历库 ---------- */
function resumeLibHtml(){
  const lib=state.resources.resumes||[];
  return `<div class="panel"><h4 class="panel-title">🗃 简历库（${lib.length}）</h4>
    <div class="row" style="margin-bottom:10px">
      <button class="btn btn-accent" onclick="pickResumePdf()">📄 导入 PDF</button>
      <input type="file" id="resume-pdf-file" accept=".pdf,application/pdf" style="display:none" onchange="importResumePdf(this)" />
      <span class="opt-in">导入超级简历导出的 PDF，自动识别文字并判断中/繁/英，存库备面试练习</span>
    </div>
    ${lib.length ? `<ul class="clean">${lib.map(r=>{
      const badge = r.type==='base' ? '<span class="tag" style="background:#e6f7ef;color:#0a7d54">基础简历</span>'
                  : r.type==='tailored' ? '<span class="tag" style="background:#eef2ff;color:var(--brand)">定制简历</span>' : '';
      return `
      <li class="item-line">
        <div style="flex:1"><b>${esc({zh:'中文简历',tw:'繁體中文',en:'英文简历',cover:'Cover Letter'}[r.kind]||r.kind)}</b>
          ${badge}
          <span class="opt-in"> · ${esc(r.title||'')} · ${new Date(r.createdAt).toLocaleString('zh-CN')}${r.source?(' · '+esc(r.source)):''}</span></div>
        <button class="btn btn-sm" onclick="viewResume('${esc(r.id)}')">查看</button>
        <button class="btn btn-sm" onclick="editResume('${esc(r.id)}')">编辑</button>
        <button class="btn btn-sm btn-danger" onclick="delResume('${esc(r.id)}')">删除</button>
      </li>`;}).join('')}</ul>`
      : `<div class="empty">暂无简历。可点上方「导入 PDF」把超级简历导出的 PDF 直接入库，或到「中文/英文简历」编辑后点「存到简历库」。</div>`}</div>`;
}
async function delResume(id){ if(!confirm('删除该简历？'))return; await API.store.del('resumes', id); state.resources.resumes=state.resources.resumes.filter(x=>x.id!==id); renderResume(); toast('已删除','ok'); }
function viewResume(id){ const r=state.resources.resumes.find(x=>x.id===id); if(!r)return; const w=window.open('','_blank'); w.document.write(`<html><head><meta charset="utf-8"><title>Resume</title><style>body{font-family:Arial,sans-serif;margin:36px;line-height:1.6;font-size:14px;white-space:pre-wrap;max-width:760px}</style></head><body>${esc(r.content)}</body></html>`); w.document.close(); }
function editResume(id){ const r=state.resources.resumes.find(x=>x.id===id); if(!r)return; state.baseResume[r.kind]=r.content; state.resumeSub={zh:'resume',tw:'tw',en:'en',cover:'cover'}[r.kind]||'resume'; state.resumeView={...(state.resumeView||{}),[r.kind]:'edit'}; renderResume(); toast('已载入编辑区','ok'); }
function pickResumePdf(){ const el=document.getElementById('resume-pdf-file'); if(el) el.click(); }
function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const fr=new FileReader();
    fr.onload=()=>{ const s=String(fr.result); resolve(s.indexOf(',')>-1 ? s.slice(s.indexOf(',')+1) : s); };
    fr.onerror=()=>reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}
function detectResumeKind(text){
  const s=String(text||'');
  const twChars=['會','報','編','製','審','計','經','歷','學','準','則','識','據','條','導','證','書','資','訊','體','務','華','與','為','業','際','網','機','習','閱','額','驗','獲','處','匯','轉','從','後','臺','對','買','賣','發','數','點','動','開','鍵'];
  let tw=0; for(const c of twChars){ if(s.includes(c)) tw++; }
  const ascii=(s.match(/[A-Za-z]/g)||[]).length;
  const cjk=(s.match(/[一-鿿]/g)||[]).length;
  const total=ascii+cjk;
  if(tw>=2) return 'tw';
  if(total && ascii/total>0.85) return 'en';
  return 'zh';
}
const RESUME_SECTION_CJK=/^(教育|学历|學歷|工作|项目|項目|实习|實習|技能|证书|證書|自我|个人|個人|荣誉|榮譽|获奖|獲獎|活动|活動|经历|經歷|背景|概述|简介|簡介|求职|求職|联系|聯繫|语言|語言|培训|培訓|研究|发表|發表|兴趣|興趣|其他|附加|主要课程|主要課程|相关课程|相關課程)/;
const RESUME_SECTION_EN=/^(summar|profile|about|education|experience|employment|skills?|certificat|projects?|awards?|honou?rs?|languages?|contact|objective|activities|course|work)\b/i;
function isSectionHeading(l){ return RESUME_SECTION_CJK.test(l) || RESUME_SECTION_EN.test(l); }
function guessResumeTitle(text){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const isName=(l)=>{
    if(!l || l.length>20) return false;
    if(isSectionHeading(l)) return false;
    if(/@|\+?\d{2,}|linkedin|电话|電話|邮箱|郵箱|http/i.test(l)) return false;
    return /^[一-龥]{2,4}([\s·（(].{0,10})?$/.test(l)   // 中文姓名
        || /^[A-Z][a-z]+(\s+[A-Z][a-z]*){1,2}(\s*\([\w\s]+\))?$/.test(l); // 英文姓名
  };
  for(const l of lines.slice(0,6)){ if(isName(l)) return l; }
  for(const l of lines.slice(0,6)){
    if(l.length<=30 && !isSectionHeading(l) && !/@|\+86|\d{4}|linkedin|tel|电话|電話|邮箱|郵箱/i.test(l)) return l;
  }
  return '';
}
async function importResumePdf(input){
  const f=input.files && input.files[0];
  if(!f) return;
  if(!/\.pdf$/i.test(f.name) && f.type!=='application/pdf'){ toast('请选择 PDF 文件','err'); input.value=''; return; }
  if(f.size > 20*1024*1024){ toast('PDF 体积 '+Math.round(f.size/1024/1024)+'MB，超过 20MB 上限，请压缩后重试','err'); input.value=''; return; }
  toast('正在解析 PDF 并识别内容…');
  try {
    const base64=await fileToBase64(f);
    const r=await API.importResumePdf({ fileBase64:base64, filename:f.name });
    if(!r.ok){ toast(r.error||'解析失败','err'); input.value=''; return; }
    const text=r.text;
    const kind=detectResumeKind(text);
    const kindLabel={zh:'简体中文',tw:'繁體中文',en:'英文'}[kind]||kind;
    const isBase=confirm('这份 PDF 是「基础简历」吗？\n\n【确定】= 基础简历（通用版，简/英各一份，作为定制简历的母本）\n【取消】= 定制简历（针对某个具体岗位）');
    const title = isBase ? ('基础简历（'+kindLabel+'）') : (guessResumeTitle(text) || f.name.replace(/\.pdf$/i,'') || '定制简历');
    const item={ kind, title, content:text, source:'PDF导入', type: isBase?'base':'tailored', createdAt:new Date().toISOString() };
    const saved=await API.store.add('resumes', item);
    state.resources.resumes.push(saved.item || item);
    if(isBase) state.baseResume[kind]=text;
    renderResume();
    toast(`已导入「${title}」（${kindLabel}${isBase?' · 基础简历':' · 定制简历'}），已存库${isBase?'并设为定制母本':''}`,'ok');
  } catch(e){ toast('导入失败：'+e.message,'err'); }
  input.value='';
}
function interviewHtml(){
  const jobs=state.resources.jobs||[];
  const resumes=state.resources.resumes||[];
  const iv=state.resources.interview||[];
  const qa=state.interviewQa||[];
  const sel=state.interviewSel||{};
  return `<div class="panel">
    <h4 class="panel-title">🎯 面试练习 <span class="opt-in">已存 ${iv.length} 组 · 选岗位 + 简历库经历 → 生成面试题 + STAR 回答</span></h4>
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <select id="iv-job" style="max-width:260px" onchange="onIvJob(this.value)">
        <option value="">选择岗位（可选，可纯粘 JD）…</option>
        ${jobs.map(j=>`<option value="${esc(j.id)}" ${sel.jobId===j.id?'selected':''}>${esc(j.company)} — ${esc(j.title)}</option>`).join('')}
      </select>
      <select id="iv-resume" style="max-width:260px" onchange="state.interviewSel.resumeId=this.value">
        <option value="">选择简历库简历（作回答依据）…</option>
        ${resumes.map(r=>`<option value="${esc(r.id)}" ${sel.resumeId===r.id?'selected':''}>${esc({zh:'中文',tw:'繁體',en:'英文'}[r.kind]||r.kind)} · ${esc(r.title||'')}</option>`).join('')}
      </select>
    </div>
    <label>岗位 JD（选岗位自动带出，或直接粘贴）
      <textarea id="iv-jd" rows="5" placeholder="粘贴 JD 或选岗位后自动填充…" oninput="state.interviewSel.jd=this.value">${esc(sel.jd||'')}</textarea>
    </label>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-primary" onclick="genInterview()">🎯 生成面试题</button>
      ${qa.length?`<button class="btn" onclick="saveInterview()">💾 存面试题库</button>`:''}
    </div>
    <div id="iv-questions" style="margin-top:12px">${qa.map((x,i)=>ivQaCard(x,i)).join('')}</div>
  </div>`;
}
function onIvJob(id){ state.interviewSel={...(state.interviewSel||{}), jobId:id, jd: state.jds[id]||state.interviewSel.jd||''}; const t=$('#iv-jd'); if(t) t.value=state.interviewSel.jd||''; }
function ivQaCard(x,i){
  return `<div class="item-line" style="align-items:stretch;flex-direction:column;border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px">
    <div class="row" style="justify-content:space-between"><b>Q${i+1}. ${esc(x.q)}</b><button class="btn btn-sm" onclick="genAnswer(${i})">${x.a?'↻ 重生成':'✨ 生成回答'}</button></div>
    ${x.a?`<div class="c-body" style="margin-top:8px;white-space:pre-wrap">${esc(x.a)}</div>`:''}
  </div>`;
}
async function genInterview(){
  if(!state.config.hasKey){ toast('请先在【设置】配置 DeepSeek API Key','err'); return; }
  const sel=state.interviewSel||{}; state.interviewSel=sel;
  const jd=($('#iv-jd')?$('#iv-jd').value:'').trim() || sel.jd || '';
  const resume=(state.resources.resumes||[]).find(r=>r.id===sel.resumeId);
  const base=resume?resume.content:'';
  if(!jd && !base){ toast('请先粘贴 JD 或选择简历库简历','err'); return; }
  toast('正在生成面试题…');
  const prompt=`你是资深面试官。基于下面的岗位 JD 和候选简历，生成 6-8 个面试问题，覆盖：自我介绍/动机、行为面试（STAR）、专业技能、AI 相关（如有）、反问建议。每个问题一句话，难度贴合岗位。

【岗位 JD】${jd||'（未提供，仅依据简历）'}

【候选简历】${base||'（未提供）'}

输出格式：每行一个问题，以「1. 」「2. 」开头，不要其他解释。`;
  const out=await aiChat([{role:'user',content:prompt}]);
  if(!out) return;
  const qs=out.split('\n').map(l=>l.replace(/^\s*\d+[\.、\)]\s*/,'').trim()).filter(Boolean);
  state.interviewQa=qs.map(q=>({q}));
  renderResume(); toast('已生成 '+qs.length+' 道题，点每题「生成回答」','ok');
}
async function genAnswer(i){
  if(!state.config.hasKey){ toast('请先在【设置】配置 DeepSeek API Key','err'); return; }
  const qa=state.interviewQa||[]; const x=qa[i]; if(!x) return;
  const sel=state.interviewSel||{};
  const resume=(state.resources.resumes||[]).find(r=>r.id===sel.resumeId);
  const base=resume?resume.content:'';
  toast('正在生成回答…');
  const prompt=`你是候选人的面试教练。用 STAR 法（情境-任务-行动-结果）为下面这道面试题生成一段 120-200 字的中文回答。必须严格基于候选简历的真实经历，不编造；没有对应经历就诚实说明并给出迁移思路。

【面试题】${x.q}

【候选简历】${base}

输出：直接给回答文本，不要标注 STAR 标签。`;
  const out=await aiChat([{role:'user',content:prompt}]);
  if(out){ x.a=out; renderResume(); toast('回答已生成','ok'); }
}
async function saveInterview(){
  const qa=(state.interviewQa||[]).filter(x=>x.a);
  if(!qa.length){ toast('还没有带回答的题','err'); return; }
  const sel=state.interviewSel||{};
  const job=(state.resources.jobs||[]).find(j=>j.id===sel.jobId);
  const item={ id:uid(), jobId:sel.jobId||'', jobLabel:job?(job.company+' — '+job.title):'', qa, createdAt:new Date().toISOString() };
  await API.store.add('interview', item);
  state.resources.interview.push(item);
  state.interviewQa=[]; renderResume(); toast('已存 '+qa.length+' 条到面试题库','ok');
}
/* ============================================================
   模块4 · 投递进度
   数据源：data/store/tracker.json（扩展填表后自动写入 / 手动新增）
   ============================================================ */
const TRACKER_STATUSES = ['待投递','已投递','笔试','面试','Offer','已拒','已关闭'];
const TRACKER_COLOR = { '待投递':'#8a93a3', '已投递':'#3b5bdb', '笔试':'#c77700', '面试':'#0f9d8f', 'Offer':'#0a7d54', '已拒':'#d64545', '已关闭':'#8a93a3' };
const TRACKER_LIVE = ['待投递','已投递','笔试','面试'];   // 进行中：需要跟进

function trackerRows(){ return (state.resources.tracker || []).slice(); }
function trackerOf(id){ return trackerRows().find(t => t.id === id); }
function trackerCounts(){
  const c = { all: 0 }; TRACKER_STATUSES.forEach(s => c[s] = 0);
  trackerRows().forEach(t => { c.all++; c[t.status] = (c[t.status] || 0) + 1; });
  return c;
}
function daysSince(s){
  if (!s) return null;
  const d = new Date(String(s).replace(/-/g, '/'));
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function renderTracker(){
  const all = trackerRows();
  const c = trackerCounts();
  const live = all.filter(t => TRACKER_LIVE.indexOf(t.status) >= 0).length;
  const rows = state.trackerFilter === 'all' ? all : all.filter(t => t.status === state.trackerFilter);

  const chips = ['all', ...TRACKER_STATUSES].map(s => {
    const n = c[s] || 0;
    const on = state.trackerFilter === s;
    const label = s === 'all' ? '全部' : s;
    return `<button class="subtab ${on ? 'active' : ''}" data-tf="${s}">${label}${n ? ' ' + n : ''}</button>`;
  }).join('');

  const body = rows.length ? rows.map(trackerCard).join('') :
    `<div class="empty">还没有投递记录。<br>用 Chrome 扩展在网申页点「填入页面」会自动记一笔；也可以在下面手动新增。</div>`;

  $('#tracker-app').innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <div class="panel-title" style="margin:0">📮 投递进度</div>
        <span class="hint" style="margin:0">共 ${c.all} 条 · 进行中 ${live} 条</span>
        <div class="space"></div>
        <button class="btn" id="tk-add">＋ 手动新增</button>
        <button class="btn" id="tk-from-jobs">从机会库导入</button>
        <button class="btn" id="tk-refresh">刷新</button>
      </div>
      <div class="subtabs" style="margin-bottom:14px">${chips}</div>
      <div id="tk-list">${body}</div>
    </div>`;
  bindTracker();
}

function trackerCard(t){
  const open = !!state.trackerOpen[t.id];
  const editing = state.trackerEdit === t.id;
  const color = TRACKER_COLOR[t.status] || '#8a93a3';
  const since = daysSince(t.submittedAt) != null ? daysSince(t.submittedAt) : daysSince(t.createdAt);
  const stale = TRACKER_LIVE.indexOf(t.status) >= 0 && since != null && since >= 14;   // 两周没动静，提醒跟进
  const qs = Array.isArray(t.questions) ? t.questions : [];
  const ev = Array.isArray(t.events) ? t.events : [];
  const dl = String(t.deadline || '').match(/^\d{4}-\d{2}-\d{2}/);
  const dlDays = dl ? Math.ceil((new Date(dl[0] + 'T23:59:59') - Date.now()) / 86400000) : null;
  const dlBadge = dlDays == null ? '' :
    dlDays < 0 ? '<span class="tk-stale" style="color:var(--danger);background:#fdeaea">⏰ 已过期 ' + (-dlDays) + ' 天</span>' :
    dlDays <= 3 ? '<span class="tk-stale">⏰ 还有 ' + dlDays + ' 天截止</span>' : '';

  return `
  <div class="tk" data-id="${esc(t.id)}">
    <div class="tk-head">
      <button class="tk-toggle" data-tk="${open ? 'close' : 'open'}" data-id="${esc(t.id)}">${open ? '▾' : '▸'}</button>
      <span class="tk-dot" style="background:${color}"></span>
      <div class="tk-title">
        <b>${esc(t.company || '（未填公司）')}</b>
        <span class="tk-role">${esc(t.title || '')}</span>
      </div>
      <span class="tk-site">${esc(t.site || '')}</span>
      ${stale ? '<span class="tk-stale">⚠ ' + since + ' 天没动静</span>' : ''}
      ${dlBadge}
      <div class="space"></div>
      <select class="tk-sel" data-tk="status" data-id="${esc(t.id)}" style="width:auto;padding:5px 8px;font-size:12.5px;border-color:${color};color:${color};font-weight:600">
        ${TRACKER_STATUSES.map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <button class="btn" data-tk="edit" data-id="${esc(t.id)}" style="padding:5px 10px">${editing ? '收起' : '编辑'}</button>
      ${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener" style="padding:5px 10px;text-decoration:none">打开 ↗</a>` : ''}
      <button class="btn" data-tk="del" data-id="${esc(t.id)}" style="padding:5px 10px;color:var(--danger)">删除</button>
    </div>
    <div class="tk-meta">
      ${t.submittedAt ? '投递于 ' + esc(t.submittedAt) : '尚未提交 · 建档 ' + esc(t.createdAt || '')} · 更新 ${esc(t.updatedAt || '')}
      ${t.filled != null ? ' · 扩展填了 ' + t.filled + ' 个字段' : ''}
      ${qs.length ? ' · 问答 ' + qs.length + ' 题' : ''}
      ${t.deadline ? ' · 截止 ' + esc(t.deadline) : ''}
      ${t.notes ? ' · ' + esc(String(t.notes).slice(0,60)) : ''}
    </div>
    ${editing ? trackerEditor(t) : ''}
    ${open ? trackerDetail(t, qs, ev) : ''}
  </div>`;
}

function trackerEditor(t){
  return `
  <div class="tk-edit">
    <div class="grid grid-2">
      <label>公司<input id="tkf-company" value="${esc(t.company || '')}"></label>
      <label>岗位<input id="tkf-title" value="${esc(t.title || '')}"></label>
    </div>
    <label>网申链接<input id="tkf-url" value="${esc(t.url || '')}" placeholder="https://..."></label>
    <div class="grid grid-2">
      <label>截止日期<input id="tkf-deadline" value="${esc(t.deadline || '')}" placeholder="2026-10-31"></label>
      <label>备注<input id="tkf-notes" value="${esc(t.notes || '')}" placeholder="内推人 / 下一步动作"></label>
    </div>
    <label>JD 原文<textarea id="tkf-jd" rows="4" placeholder="粘贴 JD，生成问答题答案时会用到">${esc(t.jd || '')}</textarea></label>
    <div class="row">
      <button class="btn btn-primary" data-tk="save" data-id="${esc(t.id)}">保存</button>
      <button class="btn" data-tk="close" data-id="${esc(t.id)}">取消</button>
    </div>
  </div>`;
}

function trackerDetail(t, qs, ev){
  return `
  <div class="tk-body">
    ${qs.length ? `<div class="tk-sec">网申问答</div>` + qs.map(q => `
      <div class="tk-qa">
        <div class="tk-q">${esc(q.q || q.question || '')}</div>
        <div class="tk-a">${esc(q.a || q.answer || '')}</div>
      </div>`).join('') : '<div class="hint">没有记录到问答题。下次在网申页点「📋 记一笔投递」会把问答一起存下来。</div>'}
    ${t.jd ? `<div class="tk-sec">JD 原文</div><div class="tk-jd">${esc(String(t.jd).slice(0, 1500))}</div>` : ''}
    ${ev.length ? `<div class="tk-sec">状态轨迹</div>` + ev.map(e => `
      <div class="tk-ev">${esc(e.ts || '')} · ${e.to ? esc(e.from) + ' → ' + esc(e.to) : esc(e.text || '')}</div>`).join('') : ''}
  </div>`;
}

function bindTracker(){
  const app = $('#tracker-app');
  if (!app) return;
  app.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { state.trackerFilter = b.dataset.tf; renderTracker(); });
  const on = (sel, fn) => app.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));

  on('[data-tk="open"],[data-tk="close"]', b => { state.trackerOpen[b.dataset.id] = !state.trackerOpen[b.dataset.id]; renderTracker(); });
  on('[data-tk="edit"]', b => { state.trackerEdit = state.trackerEdit === b.dataset.id ? null : b.dataset.id; renderTracker(); });
  on('[data-tk="close"]', b => { state.trackerEdit = null; renderTracker(); });
  on('[data-tk="del"]', async b => {
    const t = trackerOf(b.dataset.id);
    if (!t) return;
    if (!confirm('删除投递记录「' + (t.company || '未填公司') + ' — ' + (t.title || '') + '」？此操作不可撤销。')) return;
    const r = await API.tracker.remove(b.dataset.id);
    if (r && r.ok) { state.resources.tracker = trackerRows().filter(x => x.id !== b.dataset.id); renderTracker(); toast('已删除', 'ok'); }
    else toast((r && r.error) || '删除失败', 'err');
  });
  on('[data-tk="save"]', async b => {
    const patch = {
      company: ($('#tkf-company') || {}).value || '',
      title: ($('#tkf-title') || {}).value || '',
      url: ($('#tkf-url') || {}).value || '',
      deadline: ($('#tkf-deadline') || {}).value || '',
      notes: ($('#tkf-notes') || {}).value || '',
      jd: ($('#tkf-jd') || {}).value || ''
    };
    const r = await API.tracker.update(b.dataset.id, patch);
    if (r && r.ok) { Object.assign(trackerOf(b.dataset.id) || {}, r.row); state.trackerEdit = null; renderTracker(); toast('已保存', 'ok'); }
    else toast((r && r.error) || '保存失败', 'err');
  });

  app.querySelectorAll('[data-tk="status"]').forEach(sel => sel.onchange = async () => {
    const r = await API.tracker.update(sel.dataset.id, { status: sel.value });
    if (r && r.ok) { Object.assign(trackerOf(sel.dataset.id) || {}, r.row); renderTracker(); toast('状态改为「' + sel.value + '」', 'ok'); }
    else { toast((r && r.error) || '更新失败', 'err'); renderTracker(); }
  });

  const add = $('#tk-add');
  if (add) add.onclick = () => { state.trackerEdit = null; openTrackerNew(); };
  const fj = $('#tk-from-jobs');
  if (fj) fj.onclick = openTrackerFromJobs;
  const rf = $('#tk-refresh');
  if (rf) rf.onclick = () => refreshTracker(true);
}

async function refreshTracker(showToast){
  const list = await apiFetch('/api/store/tracker').then(r => r.json()).catch(() => null);
  if (Array.isArray(list)) { state.resources.tracker = list; if (state.tab === 'tracker') renderTracker(); if (showToast) toast('已刷新（' + list.length + ' 条）', 'ok'); }
  else if (showToast) toast('刷新失败，服务器可能没重启', 'err');
}

/* 手动新增 */
function tkModal(title, rows, onOk){
  const m = document.createElement('div');
  m.className = 'modal-overlay';
  m.innerHTML = `
    <div class="modal" style="width:min(620px,94vw)">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost" data-x="close">✕</button></div>
      <div class="modal-body">${rows}</div>
      <div class="modal-foot"><span class="spacer"></span>
        <button class="btn btn-ghost" data-x="cancel">取消</button>
        <button class="btn btn-primary" data-x="ok">确定</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('[data-x="close"]').onclick = close;
  m.querySelector('[data-x="cancel"]').onclick = close;
  m.querySelector('[data-x="ok"]').onclick = async () => { await onOk(m); };
  m.onclick = e => { if (e.target === m) close(); };
  return m;
}

function openTrackerNew(){
  tkModal('手动新增投递记录', `
    <div class="grid grid-2">
      <label>公司 *<input id="n-company" placeholder="PwC"></label>
      <label>岗位<input id="n-title" placeholder="Product Manager Intern"></label>
    </div>
    <label>网申链接<input id="n-url" placeholder="https://..."></label>
    <div class="grid grid-2">
      <label>状态<select id="n-status">${TRACKER_STATUSES.map(s => `<option>${s}</option>`).join('')}</select></label>
      <label>截止日期<input id="n-deadline" placeholder="2026-10-31"></label>
    </div>
    <label>备注<input id="n-notes" placeholder="内推人 / 下一步动作"></label>`, async (m) => {
    const body = {
      company: m.querySelector('#n-company').value.trim(),
      title: m.querySelector('#n-title').value.trim(),
      url: m.querySelector('#n-url').value.trim(),
      status: m.querySelector('#n-status').value,
      deadline: m.querySelector('#n-deadline').value.trim(),
      notes: m.querySelector('#n-notes').value.trim()
    };
    if (!body.company && !body.title && !body.url) { toast('至少要填公司、岗位或链接', 'err'); return; }
    const r = await API.tracker.add(body);
    if (r && r.ok) { state.resources.tracker.unshift(r.row); m.remove(); renderTracker(); toast('已新增', 'ok'); }
    else toast((r && r.error) || '新增失败', 'err');
  });
}

function openTrackerFromJobs(){
  const jobs = (state.resources.jobs || []).filter(j => j.company && !/说明|教程/.test(j.company));
  if (!jobs.length) { toast('机会库是空的，先去「② 机会库」导入', 'err'); return; }
  const m = tkModal('从机会库导入', `
    <label>搜索<input id="j-q" placeholder="公司 / 岗位 / 地区"></label>
    <div class="tbl-track" style="max-height:320px"><table class="tbl"><tbody id="j-body">${jobs.slice(0, 80).map(j => `
      <tr><td style="width:34px"><input type="checkbox" value="${esc(j.id)}" style="width:auto"></td>
      <td><b>${esc(j.company)}</b><div class="c-meta">${esc(j.title || j.workType || '')} ${esc(j.location || '')}</div></td>
      <td class="mono" style="white-space:nowrap">${esc(j.deadline || '')}</td></tr>`).join('')}</tbody></table></div>
    <div class="hint">勾选后按「确定」加入投递进度，状态为「待投递」。已经存在的同一岗位不会重复添加。</div>`, async (m) => {
    const ids = [...m.querySelectorAll('#j-body input:checked')].map(x => x.value);
    if (!ids.length) { toast('没勾选任何岗位', 'err'); return; }
    let n = 0;
    for (const id of ids) {
      const j = jobs.find(x => x.id === id);
      if (!j) continue;
      const r = await API.tracker.add({ company: j.company, title: j.title || '', url: j.applyUrl || '', deadline: (String(j.deadline || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0], jobId: j.id });
      if (r && r.ok) { const i = state.resources.tracker.findIndex(x => x.id === r.row.id); if (i >= 0) state.resources.tracker[i] = r.row; else state.resources.tracker.unshift(r.row); n++; }
    }
    m.remove(); renderTracker(); toast('已导入 ' + n + ' 条', 'ok');
  });
  const q = m.querySelector('#j-q');
  q.oninput = () => {
    const k = q.value.trim().toLowerCase();
    m.querySelector('#j-body').innerHTML = jobs.filter(j => !k || ((j.company + ' ' + j.title + ' ' + j.location).toLowerCase().indexOf(k) >= 0)).slice(0, 80).map(j => `
      <tr><td style="width:34px"><input type="checkbox" value="${esc(j.id)}" style="width:auto"></td>
      <td><b>${esc(j.company)}</b><div class="c-meta">${esc(j.title || j.workType || '')} ${esc(j.location || '')}</div></td>
      <td class="mono" style="white-space:nowrap">${esc(j.deadline || '')}</td></tr>`).join('');
  };
}

/* ============================================================
   模块6 · 网申助手 —— 字段档案（Chrome 扩展读它去填网申表单）
   ============================================================ */
const APPLY_SCHEMA = [
  { g:'身份', hint:'英文表单用「英文姓名 / First / Last」，中文表单用「中文姓名 / 姓 / 名」', f:[
    ['fullName',   '中文姓名',            '纪子悦'],
    ['fullNameEn', '英文姓名 Full Name',  'Ji Ziyue'],
    ['lastNameEn', 'Last Name（英文表单）','Ji'],
    ['firstNameEn','First Name（英文表单）','Ziyue'],
    ['lastName',   '姓（中文表单）',       '纪'],
    ['firstName',  '名（中文表单）',       '子悦'],
    ['preferredName','常用名 / Preferred Name','Sophia'],
    ['gender',     '性别 Gender',          'Female'],
    ['nationality','国籍 Nationality',     'Chinese'],
  ]},
  { g:'联系方式', f:[
    ['email',      '邮箱',                 'sophiaji2001@gmail.com'],
    ['phone',      '手机',                 '13635260153'],
    ['phoneCountryCode','电话区号',        '+86'],
    ['wechat',     '微信',                 ''],
    ['linkedin',   'LinkedIn',             'https://www.linkedin.com/in/ziyueji0806'],
    ['github',     'GitHub',               ''],
    ['website',    '个人网站 / 作品集',     ''],
  ]},
  { g:'地址', f:[
    ['city',       '城市（英文）',          'Shenzhen'],
    ['cityZh',     '城市（中文）',          '深圳'],
    ['state',      '省 / 州',              'Guangdong'],
    ['country',    '国家（英文）',          'China'],
    ['countryZh',  '国家（中文）',          '中国'],
    ['postalCode', '邮编',                 ''],
    ['address',    '详细地址',             ''],
  ]},
  { g:'教育（当前 / 最高学历）', f:[
    ['school',     '学校（英文）',          'The University of Hong Kong'],
    ['schoolZh',   '学校（中文）',          '香港大学'],
    ['degree',     '学位（英文）',          'Master of Science'],
    ['degreeZh',   '学位（中文）',          '硕士'],
    ['major',      '专业（英文）',          'Computer Science (E-Commerce and Internet Computing)'],
    ['majorZh',    '专业（中文）',          '计算机科学（电子商务与互联网计算）'],
    ['gpa',        'GPA',                  '3.62/4.00'],
    ['eduStart',   '入学时间 (YYYY-MM)',    '2026-09'],
    ['eduEnd',     '毕业时间 (YYYY-MM)',    '2027-11'],
    ['school2',    '第二学历 · 学校',       'Hong Kong Baptist University'],
    ['degree2',    '第二学历 · 学位',       'Bachelor of Business Administration'],
    ['major2',     '第二学历 · 专业',       'Accounting'],
    ['gpa2',       '第二学历 · GPA',        '3.62/4.00'],
    ['eduStart2',  '第二学历 · 入学',       '2019-09'],
    ['eduEnd2',    '第二学历 · 毕业',       '2023-06'],
  ]},
  { g:'工作', f:[
    ['company',    '公司（英文）',          'PricewaterhouseCoopers (PwC) Zhong Tian LLP'],
    ['companyZh',  '公司（中文）',          '普华永道中天会计师事务所'],
    ['jobTitle',   '职位（英文）',          'Senior Auditor'],
    ['jobTitleZh', '职位（中文）',          '高级审计员'],
    ['employmentStart','入职时间 (YYYY-MM)','2023-10'],
    ['employmentEnd',  '离职时间 (YYYY-MM)','2026-09'],
    ['responsibilities','职责概述（长问题兜底用）',''],
  ]},
  { g:'申请相关', hint:'这些是网申里最容易卡住的问题，先填好就不用来回复制', f:[
    ['expectedSalary','期望薪资',           'Negotiable'],
    ['currentSalary', '当前薪资',           ''],
    ['noticePeriod',  '到岗时间',           'Immediately available'],
    ['availableFrom', '最快可入职 (YYYY-MM)','2026-10'],
    ['workAuth',      '是否有权在当地工作',  'Yes'],
    ['requiresSponsorship','是否需要签证担保','No'],
    ['visaStatus',    '签证状态说明',        'IANG (Immigration Arrangements for Non-local Graduates) eligible upon graduation'],
    ['howHeard',      '从何得知该职位',      'Company website'],
    ['willingToRelocate','是否接受异地',     'Yes'],
    ['languages',     '语言能力',           'Mandarin (native), English (IELTS 7.5), Cantonese (fluent)'],
  ]},
];

function applyDoc(){
  if(!state.applyDoc) state.applyDoc = { profile:{}, answers:{}, history:[] };
  if(!state.applyDoc.profile) state.applyDoc.profile = {};
  if(!state.applyDoc.answers) state.applyDoc.answers = {};
  if(!state.applyDoc.history) state.applyDoc.history = [];
  return state.applyDoc;
}

function renderApply(){
  const d = applyDoc();
  const p = d.profile;
  const filled = APPLY_SCHEMA.reduce((n,g)=>n+g.f.filter(([k])=>String(p[k]||'').trim()).length,0);
  const total  = APPLY_SCHEMA.reduce((n,g)=>n+g.f.length,0);
  const groups = APPLY_SCHEMA.map(g=>`
    <div class="panel">
      <h4 class="panel-title">${esc(g.g)}${g.hint?` <span class="opt-in">${esc(g.hint)}</span>`:''}</h4>
      <div class="grid grid-2">
        ${g.f.map(([k,label,ph])=>`<label>${esc(label)}
          <input data-ak="${k}" value="${esc(p[k]||'')}" placeholder="${esc(ph||'')}">
        </label>`).join('')}
      </div>
    </div>`).join('');

  return `
  <div class="panel">
    <h4 class="panel-title">🌐 网申助手 <span class="opt-in">Chrome 扩展读这份档案去填网申表单 · 只填不提交</span></h4>
    <div class="row" style="margin-bottom:10px">
      <span class="hint" style="margin:0">档案完整度：<b>${filled} / ${total}</b> 项有值</span>
      <div class="space"></div>
      <button class="btn btn-primary" id="apply-save">💾 保存档案</button>
      <button class="btn" id="apply-test">🔌 测试本机连接</button>
      <button class="btn" id="apply-token">🔑 显示扩展令牌</button>
    </div>
    <div id="apply-status" class="hint"></div>
    <details style="margin-top:10px">
      <summary style="cursor:pointer;font-size:13px;color:#37456b;font-weight:600">📦 一次性安装扩展（点开）</summary>
      <div class="hint" style="line-height:1.9;margin-top:8px">
        1. 打开 Chrome，地址栏输入 <b>chrome://extensions</b><br>
        2. 右上角打开 <b>开发者模式</b><br>
        3. 点 <b>加载已解压的扩展程序</b>，选择这个文件夹：<br>
        <code style="background:#eef1f7;padding:2px 6px;border-radius:4px">job-app\extension</code>（本项目目录下的 extension 文件夹）<br>
        4. 打开任意网申页面，右下角会出现 <b>◈</b> 悬浮球，点开即可「扫描字段 / 填入」<br>
        <span style="color:#9aa3b4">扩展自动从本机服务取令牌，不需要你手动粘贴。若提示未连接，先确认 node server.js 正在运行。</span>
      </div>
    </details>
  </div>
  ${groups}
  <div class="panel">
    <h4 class="panel-title">📋 投递记录 <span class="opt-in">原始操作流水，状态跟进请去「④ 投递进度」</span></h4>
    ${d.history.length ? `<div class="grid">${d.history.slice().reverse().slice(0,20).map(h=>`
      <div class="card">
        <div class="c-title">${esc(h.company||'（未填公司）')} ${h.title?'· '+esc(h.title):''}</div>
        <div class="c-meta">${esc(h.ts||'')} · ${(h.questions||[]).length} 个问答题${h.filled!=null?' · 填入 '+h.filled+' 个字段':''}</div>
        ${h.url?`<div class="c-meta" style="word-break:break-all">${esc(h.url)}</div>`:''}
      </div>`).join('')}</div>`
      : '<div class="empty">还没有记录。用扩展填过一次网申后就会出现在这里。</div>'}
    <div class="row" style="margin-top:12px"><button class="btn" id="apply-go-tracker">去「④ 投递进度」跟进 →</button></div>
  </div>`;
}

function bindApply(){
  $$('[data-ak]').forEach(inp=>{
    inp.oninput = () => { applyDoc().profile[inp.dataset.ak] = inp.value; };
  });
  const gt = $('#apply-go-tracker');
  if(gt) gt.onclick = async () => { await refreshTracker(false); switchTab('tracker'); };
  const save = $('#apply-save');
  if(save) save.onclick = async () => {
    const d = applyDoc();
    const r = await API.store.put('apply', d);
    if(r && r.error) return toast('保存失败：'+r.error, 'err');
    state.resources.apply = d;
    toast('字段档案已保存 · 扩展下次打开网申页即可用','ok');
  };
  const test = $('#apply-test');
  if(test) test.onclick = async () => {
    const el = $('#apply-status');
    el.textContent = '正在测试…';
    const r = await API.store.get('apply');
    el.textContent = (r && r.profile)
      ? '✅ 本机服务正常 · 已读到档案（' + Object.keys(r.profile).filter(k=>r.profile[k]).length + ' 项有值）'
      : '⚠ 本机服务有响应但没读到档案';
    el.style.color = (r && r.profile) ? '#1a7a4a' : '#b02a2a';
  };
  const tk = $('#apply-token');
  if(tk) tk.onclick = async () => {
    const el = $('#apply-status');
    el.style.color = '';
    el.innerHTML = API_TOKEN
      ? '令牌：<code style="background:#eef1f7;padding:2px 6px;border-radius:4px;user-select:all">' + esc(API_TOKEN) + '</code> <span class="opt-in">（扩展会自动获取，这里只在排查问题时用）</span>'
      : '⚠ 还没拿到令牌。刷新页面（F5）再试；仍失败就删掉 data/token.txt 后重启服务。';
  };
}
const DEFAULT_LINKEDIN = `# HEADLINE  (157 / 220 characters)
Financial Analyst | Fintech & AI | PwC Senior Auditor (3 yrs) | Valuation · Credit Risk · Python · SQL · Power BI | HKU MSc E-Commerce & Internet Computing

# ABOUT  (~1,750 characters)
I turn financial data into decisions — three years of Big Four audit depth, now paired with Python, SQL and hands-on AI tooling.

At PwC I audited banks, asset managers, TMT and manufacturing clients across RMB 14bn of loans, 20+ unlisted equity valuations and 20+ private-equity funds — then built the automation that made the work faster instead of just grinding through it.

What I do best:
· Credit risk: IRB rating models, PD / LGD / ECL, IFRS 9 classification, 5-tier loan classification
· Valuation: DCF (FCFF / WACC), comparable companies, OPM, Black-Scholes, CAPM, DLOM
· Accounting: multi-group consolidation, IFRS / US GAAP, revenue recognition, going-concern assessment
· Data: SQL, Python, Power BI, Excel VBA, regression modelling, process automation
· AI: LLM agents with function calling and RAG, built end to end

Recent AI work: an LLM-powered financial-analysis agent (DeepSeek + Function Calling, FastAPI, Docker, GitHub Actions CI) that chains read-only SQL, standard financial models and accounting-standard RAG retrieval; plus a job-application workbench and a course-notes agent skill, both built with Claude Code.

Education: MSc in E-Commerce & Internet Computing at HKU (2026–2027); BBA (Hons) in Accounting, First-Class Honours, at HKBU (GPA 3.62/4.00).

Languages: Mandarin (native) · Cantonese (fluent) · English (IELTS 7.5, full English-medium instruction)

Key skills: Financial Analysis · Valuation · Credit Risk · IFRS · US GAAP · Consolidation · Internal Controls · Python · SQL · Power BI · Financial Modeling · Data Analytics · LLM · AI Agents · Automation

Open to fintech, financial-analysis and financial-AI roles where domain depth and technical skills compound. Let's connect: sophiaji2001@gmail.com

# EDUCATION
The University of Hong Kong (HKU) — MSc, Computer Science (E-Commerce and Internet Computing)
Sep 2026 - Nov 2027 · Hong Kong
Field of study: E-Commerce / Internet Computing
Grade: -
Description: Coursework spans e-commerce technology, digital transformation, knowledge graphs, machine learning for business & e-commerce, and computational intelligence & machine learning. Focus on applying data and AI methods to financial and business problems.
Activities: -

Beijing Normal University - Hong Kong Baptist University United International College (BNU-HKBU UIC) — BBA (Honours), Accounting
Sep 2019 - Jun 2023 · Zhuhai, Guangdong, China
Field of study: Accounting
Grade: First-Class Honours · GPA 3.62 / 4.00
Description: Graduated with First-Class Honours. Built the accounting and financial-reporting foundation that later carried into Big Four audit work.
Activities and societies: University Second-Class Scholarship; Student Internship & Practice Scholarship; 2nd Prize, Guangdong Provincial E-Commerce "Innovation, Creativity & Entrepreneurship" Challenge (11th edition)

# EXPERIENCE

PricewaterhouseCoopers (PwC) Zhong Tian LLP — Senior Auditor
Oct 2023 - Sep 2026 · Shenzhen, Guangdong, China · Full-time
(若实际办公城市不是深圳，改成实际城市)
Description:
Three years in PwC's audit practice serving banking, asset-management, TMT and manufacturing clients. Owned credit-risk reviews, valuation verification, internal-control testing, consolidated reporting and going-concern assessment, and automated the underlying analysis with Python, SQL, Power BI and VBA.
· Credit risk & impairment: led a full credit review covering over 80% of the loan book (RMB 14bn); built a three-dimensional assessment framework (financial ratios, collateral valuation, adverse-media screening); optimised IRB rating models and PD/LGD parameters, lifting rating accuracy to 95%+ and the provision coverage ratio by 12pp; flagged two high-risk loans totalling RMB 240m that defaulted the following year
· Valuation: verified fair value on 20+ unlisted equity investments using DCF (FCFF / WACC), comparable companies and Backsolve, with Black-Scholes OPM for equity allocation and DLOM for lack of marketability; led the valuation framework and SOP for 20+ private-equity funds (50+ direct projects), improving efficiency by 40%
· Internal controls: SOX / C-SOX compliance across 6 control cycles for banks, securities firms and manufacturers; mapped 120+ process nodes and 30+ key control points into a risk-control matrix, and drove remediation of one material deficiency (period-end receivable/payable reclassification); built a production-cost-inventory control framework that raised cost-variance accuracy to daily granularity
· Data & analytics: processed 100k+ journal entries in SQL with five high-risk entry filters, identifying 150+ anomalies across 56 consolidated entities; automated bond rating / interest-rate / financial-ratio ingestion in Python to build a valuation benchmark library; ran multivariate regression on business and financial data to identify the true revenue drivers behind a volume-up / revenue-down anomaly
· Consolidation & accounting standards: led multi-group consolidated statement preparation, offsetting 1,000+ intercompany transactions with a self-built VBA + SQL tool (+50% efficiency) under IFRS / US GAAP; applied the five-step revenue model across ports, securities and manufacturing clients, quantifying a RMB 30m+ contract-liability impact from loyalty points; led issuance of 10+ group audit reports covering 7 subsidiaries
· Going concern & profitability: performed segment-level gross-margin analysis and multi-year financial forecasting, assessing going-concern capacity for loss-making and new-business clients

Skills: Credit Risk · Valuation · IFRS · US GAAP · Internal Controls · SOX · SQL · Python · Power BI · Excel VBA

PricewaterhouseCoopers (PwC) Zhong Tian LLP — Audit Intern
Jan 2022 - Mar 2022 · Full-time
Description: Annual audit of a Hong Kong-listed bank.
· Owned 8+ audit areas end to end: account breakdowns, audit adjustments, variance analysis, disclosure checks, recalculation and voucher sampling
· Built the confirmation control sheet and managed 200+ bank and counterparty confirmations

Huaxing Certified Public Accountants — Audit Intern
Jun 2021 - Sep 2021 · Full-time
Description: Net-asset special audit for a construction company.
· Prepared six intercompany balance working papers, reclassification adjusting entries, ageing analysis and transaction-by-transaction internal reconciliation
· Issued intercompany confirmations and performed voucher sampling, completing roughly 30% of the team's foundational work

Ping An Insurance (Group) Company of China — Client Manager Assistant
Jul 2020 - Sep 2020 · Full-time
Description: Branch-level client management support and new-hire training assistance.
· Scored 96/100 (top 5%) on the onboarding exam and led an 8-person team to first place, earning the "Outstanding Team" certificate
· Supported daily case analysis and product briefings; as trainer assistant helped roughly 100 new hires through pre-job training, with 80%+ passing the final assessment

# PROJECTS  (添加版块 → 附加信息 → 项目)
Intelligent Financial Analysis Agent · Independent Project
2026 - Present
Built an LLM-powered financial-analysis agent with DeepSeek and Function Calling on FastAPI, containerised with Docker and tested in GitHub Actions CI (pytest). The agent chains read-only SQL (SQLite), standard financial models (margins, liquidity, leverage, ROE / ROA, turnover, WACC, DCF, IRR, ECL), TF-IDF RAG retrieval over accounting and valuation standards, and a sandboxed subprocess calculator, with read-only SQL constraints, timeouts and structured tool_trace observability, producing evidence-backed analysis reports.
Skills: LLM · AI Agents · Function Calling · RAG · Python · FastAPI · Docker · CI/CD

Job Application Workbench & Course-Notes Agent Skill · Built with Claude Code
2026 - Present
Built a personal job-application workbench from scratch (Node/Express backend, single-page frontend) integrating the DeepSeek LLM API for job-description analysis, experience polishing and interview-question generation, parsing a 1,500+ row job Excel sheet with PDF export. Also built a course-notes agent skill that splits lecture PDFs into bilingual lesson pages, explains algorithms line by line and auto-generates graded exercises with an in-browser runnable code workspace (Pyodide), covering 3 courses.
Skills: LLM · AI Agents · Prompt Engineering · Node.js · Python

# SKILLS  (加满 50，前 3 置顶)
Top 3 featured: Financial Analysis · Valuation · Python
Financial Analysis · Valuation · Python · SQL · Power BI · Excel VBA · Financial Modeling · Credit Risk · IRB Rating Models · PD / LGD / ECL · IFRS 9 · IFRS · US GAAP · Consolidated Financial Statements · Revenue Recognition · Internal Controls · SOX · C-SOX · Risk Assessment · Data Analysis · Regression Analysis · Stata · SPSS · Microsoft Excel · Microsoft Office · DCF Valuation · Comparable Company Analysis · Black-Scholes · CAPM · Private Equity · Asset Management · Auditing · External Audit · Financial Reporting · Business Analysis · Process Automation · Dashboard Design · LLM · AI Agents · Function Calling · RAG · Prompt Engineering · FastAPI · Docker · Git · GitHub Actions · Node.js · Cantonese · Mandarin · English

# CERTIFICATIONS  (添加版块 → 附加信息 → 证书)
· Microsoft Office Specialist (MOS) - Excel Expert
· Microsoft Technology Associate (MTA) - Python
· CET-6 (College English Test Band 6)
· CET-4 (College English Test Band 4)

# KEYWORDS  (自然嵌在 Headline / About / Experience 里)
Fintech · Financial Analysis · Credit Risk · Valuation · IFRS · US GAAP · Python · SQL · Power BI · Data Analytics · AI · LLM · AI Agent · Automation

# ACTION ITEMS
1. [ ] Headline 替换（157 字符，未超 220）
2. [ ] About 整段粘贴（约 1,750 字符，未超 2,600）
3. [ ] Education 加 2 条：HKU + BNU-HKBU UIC（学校/学位/专业/时间/成绩/活动 逐项填）
4. [ ] Experience 加 4 条：PwC 高级审计员（1 段描述 + 6 bullet）、PwC 实习、华兴实习、平安实习
5. [ ] PwC 高级审计员「地点」栏按实际办公城市改（默认填 Shenzhen）
6. [ ] 添加版块 → 附加信息 → 项目，加「智能财务分析 Agent」「求职工作台」
7. [ ] 添加版块 → 附加信息 → 证书，加 4 条
8. [ ] Skills 加满，前 3 置顶 Financial Analysis / Valuation / Python
9. [ ] Featured 加「智能财务分析 Agent」「求职工作台」
10. [ ] 打开 Open to Work（仅 recruiter 可见），选 Fintech / Financial Analyst / Business Analyst
11. [ ] 找前 PwC 经理 / 客户求 5+ 条推荐`;

function renderLinkedin(){
  const el=$('#linkedin-app');
  const cur = state.linkedin != null ? state.linkedin : DEFAULT_LINKEDIN;
  el.innerHTML = `<div class="panel">
    <h4 class="panel-title">🌐 LinkedIn 个人主页文案 <span class="opt-in">基于现有简历生成 · 可编辑 / 复制 / AI 重新生成</span></h4>
    <div class="row" style="margin-bottom:10px">
      <button class="btn" onclick="resetLinkedin()">↺ 默认</button>
      <button class="btn" onclick="regenLinkedin()">✨ AI 重新生成</button>
      <button class="btn btn-primary" onclick="copyLinkedin()">📋 复制全部</button>
    </div>
    <textarea id="li-text" rows="28" oninput="state.linkedin=this.value" style="font-family:var(--mono);font-size:13px;line-height:1.6">${esc(cur)}</textarea>
    <div class="hint" style="margin-top:8px">英文为主（投香港/外企）；投内地可点「AI 重新生成」并在对话里要求中文。</div>
  </div>`;
}
function resetLinkedin(){ state.linkedin=null; renderLinkedin(); }
function copyLinkedin(){ const t=$('#li-text'); copyText((t?t.value:DEFAULT_LINKEDIN), 'LinkedIn 文案已复制'); }
async function regenLinkedin(){
  if(!state.config.hasKey){ toast('请先在【设置】配置 DeepSeek API Key','err'); return; }
  const base = state.baseResume.en!=null ? state.baseResume.en : DEFAULT_EN;
  toast('AI 正在生成 LinkedIn 文案…');
  const prompt=`你是 LinkedIn 个人主页优化专家。基于下面这份英文简历，生成一套优化后的 LinkedIn 文案，遵循 linkedin-profile-optimizer 的结构：Headline（≤220 字符，含关键词）、About（3-5 段约 1500-2000 字符）、Experience（当前岗位描述 + bullet）、Skills、Keywords、Action Items。用英文输出，保留所有真实事实，不编造。

【简历】
${base}

输出格式（Markdown）：
# HEADLINE
...
# ABOUT
...
# EXPERIENCE
...
# SKILLS
...
# KEYWORDS
...
# ACTION ITEMS
1. [ ] ...`;
  const out=await aiChat([{role:'user',content:prompt}]);
  if(out){ state.linkedin=out; renderLinkedin(); toast('已生成，可再手动改','ok'); }
}

/* ---------------- init ---------------- */
async function init(){
  // 任何静默失败都弹出来，不再"点了没反应"
  window.addEventListener('error', e=>{ try{ toast('脚本错误：'+(e.message||e.type),'err'); }catch(_){} });
  window.addEventListener('unhandledrejection', e=>{ try{ const r=e.reason; toast('未处理的错误：'+((r&&r.message)||r),'err'); }catch(_){} });
  loadJdEntry();
  try { const t = await API.token(); API_TOKEN = (t && t.token) || ''; }
  catch(e){ console.warn('取令牌失败', e); }
  await loadConfig();
  await loadStoreAll();
  await cvLoadSaved();
  $$('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('#btn-settings').onclick = openSettings;
  $('#btn-close-settings').onclick = () => $('#settingsModal').hidden = true;
  $('#btn-save-config').onclick = saveConfig;
  $('#btn-test').onclick = testConn;
  // 支持 ?tab=apply 这类深链，方便直接打开某个模块
  const wantTab = new URLSearchParams(location.search).get('tab');
  switchTab(wantTab && document.querySelector('.tab[data-tab="' + wantTab + '"]') ? wantTab : 'material');
}
init();
