/* ============================================================
   求职工作台 · 网申助手 —— 内容脚本
   只填不提交。所有被写入的字段会高亮，你复核后自己点提交。
   ============================================================ */
(() => {
'use strict';
if (window.__JOBAPP_APPLY__) return;
window.__JOBAPP_APPLY__ = true;
if (window.top !== window) return; // 只在顶层框架显示；iframe 里的表单请直接打开它的链接

/* ---------------- 每站停用（页面异常时的保险丝） ---------------- */
const DISABLED_KEY = 'jobappDisabledHosts';
async function disabledHosts() {
  try {
    const st = await chrome.storage.local.get(DISABLED_KEY);
    return Array.isArray(st[DISABLED_KEY]) ? st[DISABLED_KEY] : [];
  } catch (e) { return []; }
}
async function setHostDisabled(host, on) {
  const list = await disabledHosts();
  const next = on ? list.filter(h => h !== host).concat(host) : list.filter(h => h !== host);
  try { await chrome.storage.local.set({ [DISABLED_KEY]: next }); } catch (e) {}
}

/* ---------------- 与扩展后台通信 ---------------- */
function bg(payload) {
  return new Promise(resolve => {
    if (!chrome.runtime || !chrome.runtime.id) {
      return resolve({ ok: false, error: '扩展上下文已失效，请刷新页面（F5）' });
    }
    try {
      chrome.runtime.sendMessage(payload, resp => {
        const e = chrome.runtime.lastError;
        if (e) return resolve({ ok: false, error: e.message });
        resolve(resp || { ok: false, error: '扩展后台没有响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: '扩展上下文已失效，请刷新页面（F5）：' + (e && e.message || e) });
    }
  });
}

let PROFILE = null;
let ANSWERS = {};

async function loadProfile() {
  const r = await bg({ type: 'jobapp-api', path: '/api/store/apply' });
  if (!r.ok) return { ok: false, error: r.error || '读取字段档案失败' };
  const d = r.data || {};
  PROFILE = d.profile || {};
  ANSWERS = d.answers || {};
  return { ok: true };
}

/* ---------------- 文本归一化 ---------------- */
// 全角转半角、转小写、去掉所有空白与标点 → 「First Name *」和「first_name」都变成 firstname
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '');
}

/* ---------------- 字段字典 ----------------
   每项 [规范名, [别名…]]。匹配时取「命中别名最长者」，所以 firstname 一定赢过 name。 */
const DICT = [
  // 身份
  ['fullNameEn',   ['fullnameenglish', 'nameinenglish', 'englishname', 'englishfullname', '英文姓名', '英文名']],
  ['fullName',     ['fullname', 'yourfullname', 'legalname', 'applicantname', 'name', '姓名', '真实姓名', '中文姓名']],
  ['lastName',     ['lastname', 'surname', 'familyname', '姓氏', '姓']],
  ['firstName',    ['firstname', 'givenname', 'forename', '名字', '名']],
  ['preferredName',['preferredname', 'nickname', '常用名', '昵称', '称呼']],
  // 联系方式
  ['email2',       ['confirmemail', 'emailconfirm', 'retypeemail', 'repeatemail', 'verifyemail', 'emailagain', '再次输入邮箱', '确认邮箱', '重复邮箱']],
  ['email',        ['emailaddress', 'email', 'emailaddr', '电邮', '电子邮箱', '电子邮件', '邮箱']],
  ['phone',        ['mobilephone', 'phonenumber', 'telephonenumber', 'contactnumber', 'cellphone', 'telephone', 'mobile', 'phone', '手机号码', '联系电话', '联络电话', '电话号码', '手机', '电话']],
  ['phoneCountryCode', ['countrycode', 'dialcode', 'areacode', 'phonecode', '区号', '国家代码']],
  ['wechat',       ['wechat', 'weixin', '微信']],
  // 线上主页
  ['linkedin',     ['linkedinurl', 'linkedinprofile', 'linkedin', '领英']],
  ['github',       ['githuburl', 'github']],
  ['website',      ['personalwebsite', 'portfolio', 'homepage', 'website', 'blog', '个人网站', '作品集']],
  // 地址
  ['postalCode',   ['postalcode', 'zipcode', 'postcode', 'zip', '邮政编码', '邮编']],
  ['address',      ['addressline', 'streetaddress', 'mailingaddress', 'address', '详细地址', '通讯地址', '地址']],
  ['city',         ['city', 'town', '所在城市', '现居城市', '城市']],
  ['state',        ['province', 'state', 'region', '省份', '省']],
  ['country',      ['countryregion', 'country', 'nation', '国家地区', '国家']],
  ['nationality',  ['nationality', '国籍']],
  ['gender',       ['gender', 'sex', '性别']],
  // 教育
  ['school',       ['universityname', 'schoolname', 'institutionname', 'university', 'institution', 'school', 'college', '毕业院校', '院校', '学校', '大学']],
  ['degree',       ['degreetype', 'educationlevel', 'qualification', 'degree', '学历', '学位']],
  ['major',        ['fieldofstudy', 'major', 'discipline', 'programme', 'program', 'subject', '所学专业', '就读专业', '专业']],
  ['gpa',          ['gradepointaverage', 'gradepoint', 'averagegrade', 'gpa', '平均绩点', '绩点', '平均分']],
  ['eduStart',     ['educationstartdate', 'schoolstartdate', 'enrollmentdate', '入学时间', '入学日期']],
  ['eduEnd',       ['educationenddate', 'schoolenddate', 'expectedgraduation', 'graduationdate', '预计毕业', '毕业时间', '毕业日期']],
  // 工作
  ['company',      ['companyname', 'currentcompany', 'employer', 'organization', 'company', '公司名称', '工作单位', '单位', '公司']],
  ['jobTitle',     ['currentposition', 'jobposition', 'jobtitle', 'position', 'title', 'role', '职位', '岗位', '职务']],
  ['employmentStart', ['employmentstartdate', 'workstartdate', 'startdateemployment', '入职时间', '开始工作时间']],
  ['employmentEnd',   ['employmentenddate', 'workenddate', '离职时间', '结束时间']],
  ['responsibilities', ['jobdescription', 'responsibilities', 'duties', 'workdescription', '工作内容', '工作描述', '职责']],
  // 申请
  ['expectedSalary',   ['expectedsalary', 'salaryexpectation', 'desiredsalary', 'expectedcompensation', '期望薪资', '期望薪水', '薪资要求']],
  ['currentSalary',    ['currentsalary', 'presentsalary', '目前薪资', '当前薪资']],
  ['noticePeriod',     ['noticeperiod', 'availabilityperiod', 'notice', '到岗时间', '通知期', '离职通知期']],
  ['availableFrom',    ['availablefrom', 'earlieststartdate', 'startavailability', 'availabledate', '最快到岗', '可入职时间']],
  ['requiresSponsorship', ['requiressponsorship', 'needssponsorship', 'sponsorshiprequired', 'visasupport', '是否需要签证担保', '签证担保', '签证赞助']],
  ['workAuth',         ['workauthorization', 'workauthorisation', 'authorizedtowork', 'authorisedtowork', 'righttowork', 'legallyauthorized', '是否有权工作', '工作许可', '工作签证']],
  ['visaStatus',       ['visastatus', 'currentvisa', '签证状态', '签证类型']],
  ['howHeard',         ['howdidyouhear', 'howheard', 'sourceofapplication', 'referralsource', '招聘渠道', '获知渠道', '从何得知']],
  ['willingToRelocate',['willingtorelocate', 'relocat', '是否接受异地']],
  ['languages',        ['languageproficiency', 'languages', '语言能力']],
];
// 命中这些关键词的控件一律不碰：搜索框、验证码、密码、登录名
const SKIP_RE = /captcha|验证码|password|密码|search|查询|搜索|keyword|login|username|账号|用户名|coupon|promo|优惠码|securitycode|短信|verificationcode/;
// 日期型字段（值是 YYYY-MM，写入时按控件类型重新格式化）
const DATE_KEYS = new Set(['eduStart', 'eduEnd', 'employmentStart', 'employmentEnd', 'availableFrom']);

/* ---------------- 读取控件标签 ---------------- */
function labelParts(el) {
  const out = [];
  const push = v => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (t) out.push(t); };
  try {
    if (el.id) {
      document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]').forEach(l => push(l.innerText));
    }
  } catch (e) {}
  const wrap = el.closest('label');
  if (wrap) push(wrap.innerText);
  push(el.getAttribute('aria-label'));
  const lb = el.getAttribute('aria-labelledby');
  if (lb) lb.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) push(n.innerText); });
  push(el.getAttribute('placeholder'));
  push(el.getAttribute('autocomplete'));
  push(el.getAttribute('name'));
  push(el.id);
  push(el.getAttribute('data-field'));
  push(el.getAttribute('data-automation-id')); // Workday
  return out;
}
function labelBlob(el) {
  const parts = labelParts(el);
  // 同级容器的说明文字（有些表单把标签写成旁边的 span）。
  // 只在容器很小的时候采信，否则会把邻居字段的标签也吸进来，导致误匹配。
  const box = el.closest('div,fieldset,li,tr,td,section');
  if (box && box.querySelectorAll('input,select,textarea').length <= 4) {
    const t = (box.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 120) parts.push(t);
  }
  return norm(parts.join(' '));
}
function prettyLabel(el) {
  const parts = labelParts(el);
  const first = parts.find(p => /[一-鿿]/.test(p) || /[a-zA-Z]{2}/.test(p)) || parts[0] || '(无标签)';
  return first.length > 34 ? first.slice(0, 34) + '…' : first;
}

/* ---------------- 匹配 ---------------- */
// name 属性写成 camelCase 时，归一化后词与词会粘在一起（requiresSponsorship → requiressponsorship）。
// 再比一遍「压掉连续重复字母」的形式，挡掉这类单复数/拼写差一个字母的漏配。
function collapse(s) { return s.replace(/(.)\1+/g, '$1'); }

function matchField(blob) {
  if (!blob) return null;
  const cb = collapse(blob);
  let best = null, bestScore = 0;
  for (const [key, aliases] of DICT) {
    for (const a of aliases) {
      if (a.length <= bestScore) continue;
      if (blob.indexOf(a) >= 0 || cb.indexOf(collapse(a)) >= 0) { best = key; bestScore = a.length; }
    }
  }
  return best;
}

/* ---------------- 取值 ---------------- */
// 中文站点填中文名/中文学校，英文站点填英文，避免把「子悦」写进 First Name
const ZH_PAGE = (() => {
  try {
    const h = location.hostname || '';
    if (/(^|\.)(cn|com\.cn)$/i.test(h)) return true;
    if (/zhaopin|51job|zhipin|liepin|lagou|maimai|shixiseng|nowcoder|yingjiesheng|wjx|mokahr|beisen/i.test(h)) return true;
    return /^zh/i.test(document.documentElement.lang || '');
  } catch (e) { return false; }
})();
function pick(zh, en) { return ZH_PAGE ? (zh || en) : (en || zh); }

const VALUE = {
  fullName: p => pick(p.fullName, p.fullNameEn), fullNameEn: p => p.fullNameEn || p.fullName,
  lastName: p => pick(p.lastName, p.lastNameEn), firstName: p => pick(p.firstName, p.firstNameEn),
  preferredName: p => p.preferredName || p.firstNameEn,
  email: p => p.email, email2: p => p.email,
  phone: p => p.phone, phoneCountryCode: p => p.phoneCountryCode || p.countryCode,
  wechat: p => p.wechat,
  linkedin: p => p.linkedin, github: p => p.github, website: p => p.website,
  postalCode: p => p.postalCode, address: p => p.address,
  city: p => pick(p.cityZh, p.city), state: p => p.state,
  country: p => pick(p.countryZh, p.country),
  nationality: p => p.nationality, gender: p => p.gender,
  school: p => pick(p.schoolZh, p.school), degree: p => pick(p.degreeZh, p.degree),
  major: p => pick(p.majorZh, p.major),
  gpa: p => p.gpa, eduStart: p => p.eduStart, eduEnd: p => p.eduEnd,
  company: p => pick(p.companyZh, p.company), jobTitle: p => pick(p.jobTitleZh, p.jobTitle),
  employmentStart: p => p.employmentStart, employmentEnd: p => p.employmentEnd,
  responsibilities: p => p.responsibilities,
  expectedSalary: p => p.expectedSalary, currentSalary: p => p.currentSalary,
  noticePeriod: p => p.noticePeriod, availableFrom: p => p.availableFrom,
  workAuth: p => p.workAuth, requiresSponsorship: p => p.requiresSponsorship,
  visaStatus: p => p.visaStatus, howHeard: p => p.howHeard,
  willingToRelocate: p => p.willingToRelocate, languages: p => p.languages,
};
function resolve(key) {
  try { const f = VALUE[key]; const v = f ? f(PROFILE || {}) : ''; return v == null ? '' : String(v); }
  catch (e) { return ''; }
}

/* ---------------- select 选项别名 ---------------- */
// 档案里写 "China"，下拉框里是「中国」也能选中
const SELECT_ALIASES = {
  china: ['中国', '中国大陆', '中华人民共和国', 'prc', 'cn', 'mainlandchina', 'chinamainland'],
  hongkong: ['香港', 'hk', 'hongkongsar', '香港特别行政区'],
  shenzhen: ['深圳'],
  yes: ['是', '有', 'yes', 'y', 'true', '1', '同意', '确认', '可以'],
  no: ['否', '无', '没有', 'no', 'n', 'false', '0', '不可以'],
  female: ['女', 'female', 'f', 'woman', '女士'],
  male: ['男', 'male', 'm', 'man', '先生'],
  negotiable: ['面议', '可议', 'negotiable', 'open', '待定', '均可'],
  immediatelyavailable: ['随时', '立即', '随时到岗', '随时可到岗', 'immediately', 'immediate', 'asap', 'now'],
  masterofscience: ['硕士', '硕士研究生', 'msc', 'master', 'masterofscience', 'masterdegree'],
  bachelorofbusinessadministration: ['本科', '学士', 'bba', 'bachelor', 'bachelorofbusinessadministration', 'bachelordegree'],
  currentlystudying: ['在读', 'currentstudent', 'currentlyenrolled', 'studying'],
};
function aliasSet(desired) {
  const w = norm(desired);
  const set = [w];
  const extra = SELECT_ALIASES[w];
  if (extra) extra.forEach(a => set.push(norm(a)));
  // 反向：档案值本身就是某个别名时，也把主词加进来
  for (const k in SELECT_ALIASES) {
    if (SELECT_ALIASES[k].some(a => norm(a) === w)) { set.push(k); SELECT_ALIASES[k].forEach(a => set.push(norm(a))); }
  }
  return [...new Set(set.filter(Boolean))];
}

/* ---------------- 写入 ---------------- */
// React / Vue 受控组件：必须走原型上的原生 setter，再派发 input/change。
// 直接 el.value = x 会被框架的 state 覆盖，等于没填。
function setNative(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  try {
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
  } catch (e) { el.value = value; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function formatDateFor(el, ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{1,2})/);
  if (!m) return ym;
  const y = m[1], mo = m[2].padStart(2, '0');
  const t = (el.type || '').toLowerCase();
  if (t === 'date') return y + '-' + mo + '-01';
  if (t === 'month') return y + '-' + mo;
  const hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('pattern') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
  if (/yyyy[-\/年]?mm[-\/月]?dd/.test(hint)) return hint.indexOf('dd') < hint.indexOf('mm') ? '01/' + mo + '/' + y : mo + '/01/' + y;
  if (/mm[-\/]yyyy/.test(hint) || /mm[-\/]yy\b/.test(hint)) return mo + '/' + y;
  if (/yyyy年/.test(hint)) return y + '年' + mo + '月';
  if (/yyyy[-\/]mm/.test(hint)) return y + '-' + mo;
  return mo + '/' + y;
}

function setSelect(el, desired) {
  const want = aliasSet(desired);
  const opts = [...el.options].filter(o => !o.disabled);
  let hit = opts.find(o => want.includes(norm(o.text)) || want.includes(norm(o.value)));
  if (!hit) hit = opts.find(o => { const t = norm(o.text); return t && want.some(w => t.indexOf(w) >= 0); });
  if (!hit) hit = opts.find(o => { const v = norm(o.value); return v && want.some(w => v.indexOf(w) >= 0); });
  if (!hit) return false;
  el.value = hit.value;
  // 有些下拉是自定义组件，改完 value 还要按索引重设一次
  if (el.selectedIndex !== opts.indexOf(hit)) el.selectedIndex = [...el.options].indexOf(hit);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

function setValue(el, key, raw) {
  let v = raw;
  if (DATE_KEYS.has(key)) v = formatDateFor(el, v);
  else if ((el.type === 'date' || el.type === 'month') && /^\d{4}-\d{1,2}/.test(v)) v = formatDateFor(el, v);
  if (el.tagName === 'SELECT') return setSelect(el, v);
  setNative(el, v);
  return true;
}

function hasValue(el) {
  if (el.tagName === 'SELECT') return el.selectedIndex > 0 && String(el.value).trim() !== '';
  return String(el.value || '').trim() !== '';
}
function isVisible(el) {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

/* ---------------- 高亮 ---------------- */
const HL = 'jobapp-filled';
function injectHl() {
  if (document.getElementById('jobapp-hl-style')) return;
  const s = document.createElement('style');
  s.id = 'jobapp-hl-style';
  s.textContent = '.' + HL + '{outline:2px solid #3b5bdb !important;outline-offset:1px !important;background:rgba(59,91,219,.07) !important;transition:background .2s}';
  (document.head || document.documentElement).appendChild(s);
}
function clearHl() {
  document.querySelectorAll('.' + HL).forEach(el => {
    el.classList.remove(HL);
    if (el.dataset.jobappSrc) { el.removeAttribute('title'); delete el.dataset.jobappSrc; }
  });
}

/* ---------------- 扫描 / 填充 ---------------- */
function collect() {
  const rows = [];
  const all = document.querySelectorAll('input,select,textarea');
  for (const el of all) {
    const t = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search', 'checkbox', 'radio'].includes(t)) continue;
    if (el.disabled || el.readOnly) continue;
    if (!isVisible(el)) continue;
    const blob = labelBlob(el);
    if (SKIP_RE.test(blob)) continue;
    const key = matchField(blob);
    rows.push({ el, key, label: prettyLabel(el), value: key ? resolve(key) : '', filled: el.classList.contains(HL), has: hasValue(el) });
  }
  return rows;
}

function fillAll(overwrite) {
  injectHl();
  const rows = collect();
  const report = { matched: 0, filled: 0, skippedHas: 0, noKey: 0, empty: 0, failed: [], rows };
  for (const r of rows) {
    if (!r.key) { report.noKey++; continue; }
    report.matched++;
    if (!r.value) { report.empty++; continue; }
    if (!overwrite && r.has) { report.skippedHas++; continue; }
    let ok = false;
    try { ok = setValue(r.el, r.key, r.value); } catch (e) { ok = false; }
    if (ok) {
      report.filled++;
      r.el.classList.add(HL);
      r.el.dataset.jobappSrc = r.key;
      const old = r.el.getAttribute('title') || '';
      r.el.setAttribute('title', (old ? old + ' | ' : '') + '网申助手填入：' + r.key);
      r.filled = true;
    } else {
      report.failed.push(r.label);
    }
  }
  return report;
}

/* ---------------- 浮动面板（Shadow DOM，隔离网申页样式） ---------------- */
let ui = null;
function buildPanel() {
  const host = document.createElement('div');
  host.id = 'jobapp-apply-host';
  host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647';
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  *{box-sizing:border-box;font-family:-apple-system,'Segoe UI','Microsoft YaHei',Arial,sans-serif}
  .ball{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#3b5bdb,#5c7cfa);color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;
        box-shadow:0 6px 20px rgba(59,91,219,.42);user-select:none}
  .ball:hover{transform:translateY(-2px)}
  .panel{position:absolute;right:0;bottom:64px;width:428px;max-height:78vh;display:flex;flex-direction:column;
         background:#fff;border:1px solid #dbe1ec;border-radius:12px;box-shadow:0 16px 48px rgba(20,28,45,.24);overflow:hidden}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f4f6fb;border-bottom:1px solid #e3e8f2;cursor:move;user-select:none}
  .ttl{font-size:13px;font-weight:700;color:#1e2a44}
  .stat{font-size:11px;padding:2px 7px;border-radius:9px;background:#e8ecf5;color:#5a6478}
  .stat.ok{background:#e3f6ec;color:#1a7a4a}
  .stat.err{background:#fdeaea;color:#b02a2a}
  .hd .x{margin-left:auto;border:0;background:transparent;font-size:15px;color:#7b859a;cursor:pointer;padding:2px 4px}
  .bar{display:flex;gap:6px;padding:10px 12px 6px}
  .bar button{flex:1;padding:7px 6px;font-size:12px;border:1px solid #c9d2e3;background:#fff;color:#37456b;
              border-radius:7px;cursor:pointer}
  .bar button:hover{background:#eef2fb}
  .bar button.primary{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
  .bar button.primary:hover{background:#3350c9}
  .bar button:disabled{opacity:.5;cursor:default}
  .ov{display:flex;align-items:center;gap:6px;padding:0 12px 8px;font-size:11.5px;color:#5a6478;cursor:pointer}
  .list{flex:1;overflow:auto;border-top:1px solid #eef1f7}
  .r{display:flex;gap:6px;align-items:baseline;padding:6px 12px;border-bottom:1px solid #f4f6fa;font-size:11.5px}
  .r:hover{background:#fafbfe}
  .r .k{flex:0 0 38%;color:#37456b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .r .v{flex:1;color:#1a7a4a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .r .v.none{color:#aab2c2}
  .r .s{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:6px;background:#eef1f7;color:#79839a}
  .r .s.ok{background:#e3f6ec;color:#1a7a4a}
  .r .s.warn{background:#fdf3e2;color:#9a6b12}
  .log{padding:7px 12px;border-top:1px solid #eef1f7;background:#fafbfe;font-size:11px;color:#6b7488;
       max-height:96px;overflow:auto;white-space:pre-wrap;line-height:1.5}
  .log b{color:#b02a2a}
  .hint{padding:0 12px 8px;font-size:10.5px;color:#98a1b3;line-height:1.5}
  .tabs{display:flex;border-bottom:1px solid #e3e8f2;background:#fbfcfe}
  .tabs button{flex:1;padding:8px 0;font-size:12px;border:0;background:transparent;color:#79839a;cursor:pointer;
               border-bottom:2px solid transparent}
  .tabs button.on{color:#3b5bdb;font-weight:700;border-bottom-color:#3b5bdb}
  .pane{flex:1;overflow:auto;display:none;flex-direction:column;min-height:0}
  .pane.on{display:flex}
  .ctx{padding:9px 12px;border-bottom:1px solid #eef1f7;background:#fafbfe}
  .ctx input,.ctx textarea{width:100%;border:1px solid #d5dced;border-radius:6px;padding:5px 7px;font-size:11.5px;
                           font-family:inherit;margin-bottom:5px;background:#fff;color:#1e2a44}
  .ctx textarea{height:52px;resize:vertical}
  .q{border-bottom:1px solid #f1f4f9;padding:9px 12px}
  .q .qt{font-size:11.5px;color:#1e2a44;font-weight:600;line-height:1.5;margin-bottom:5px}
  .q .qm{font-size:10px;color:#98a1b3;margin-bottom:6px}
  .q textarea{width:100%;border:1px solid #d5dced;border-radius:7px;padding:7px 8px;font-size:11.5px;line-height:1.6;
              font-family:inherit;color:#1e2a44;background:#fff;resize:vertical;min-height:76px}
  .q .qb{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}
  .q .qb button{padding:4px 9px;font-size:11px;border:1px solid #c9d2e3;background:#fff;color:#37456b;
                border-radius:6px;cursor:pointer}
  .q .qb button:hover{background:#eef2fb}
  .q .qb button.p{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
  .q .qb button.p:hover{background:#3350c9}
  .q .qb button:disabled{opacity:.45;cursor:default}
  .q .cc{font-size:10.5px;color:#98a1b3;margin-left:auto;align-self:center}
  .q .cc.over{color:#b02a2a;font-weight:700}
  .q .src{font-size:10px;color:#9aa3b4;margin-top:4px;line-height:1.5}
  .empty{padding:16px 12px;font-size:11.5px;color:#98a1b3;text-align:center}
</style>
<div class="ball" id="ball" title="网申助手">◈</div>
<div class="panel" id="panel" hidden>
  <div class="hd" id="hd"><span class="ttl">◈ 网申助手</span><span class="stat" id="stat">连接中…</span><button class="x" id="disable" title="在此网站停用（页面打不开时可救命）">⛔</button><button class="x" id="close">✕</button></div>
  <div class="tabs">
    <button id="tab-f" class="on">表单字段</button>
    <button id="tab-q">问答题</button>
  </div>

  <div class="pane on" id="pane-f">
    <div class="bar">
      <button id="scan">🔍 扫描字段</button>
      <button id="fill" class="primary">✍️ 填入</button>
      <button id="clear">清空高亮</button>
    </div>
    <label class="ov"><input type="checkbox" id="overwrite"> 覆盖已有内容（默认跳过非空字段）</label>
    <div class="hint">只填不提交。填过的字段有蓝色描边，鼠标悬停可看填的是哪一项。</div>
    <div class="list" id="list"></div>
  </div>

  <div class="pane" id="pane-q">
    <div class="ctx">
      <input id="ctx-company" placeholder="公司（猜错了就改）">
      <input id="ctx-title" placeholder="职位">
      <textarea id="ctx-jd" placeholder="粘贴岗位 JD —— 贴了答案才会贴着这个岗位写（可留空）"></textarea>
    </div>
    <div class="bar" style="padding-bottom:4px">
      <button id="qscan">🔍 找出问答题</button>
      <button id="qlog" style="flex:0 0 auto">📋 记一笔投递</button>
    </div>
    <div class="hint">只生成待你确认的草稿，点「填入」才写进页面。事实全部来自工作台的经历库，不会编造数字。</div>
    <div class="qs" id="qs"></div>
  </div>

  <div class="log" id="log"></div>
</div>`;

  const $ = s => root.querySelector(s);
  ui = { host, root, $, list: $('#list'), qs: $('#qs'), log: $('#log'), stat: $('#stat') };
  $('#ball').onclick = () => { $('#panel').hidden = false; $('#ball').style.display = 'none'; };
  $('#close').onclick = () => { $('#panel').hidden = true; $('#ball').style.display = 'flex'; };
  $('#disable').onclick = async () => {
    await setHostDisabled(location.hostname, true);
    log('已在此网站停用，即将刷新。想恢复：点右下角灰点，或去 chrome://extensions 重新加载扩展。');
    setTimeout(() => location.reload(), 900);
  };
  $('#scan').onclick = doScan;
  $('#fill').onclick = doFill;
  $('#clear').onclick = () => { clearHl(); log('已清空高亮'); };
  $('#tab-f').onclick = () => switchPane('f');
  $('#tab-q').onclick = () => switchPane('q');
  $('#qscan').onclick = doQuestionScan;
  $('#qlog').onclick = () => logApply();
  dragify($('#hd'), host);
}

function switchPane(which) {
  if (!ui) return;
  ui.$('#tab-f').classList.toggle('on', which === 'f');
  ui.$('#tab-q').classList.toggle('on', which === 'q');
  ui.$('#pane-f').classList.toggle('on', which === 'f');
  ui.$('#pane-q').classList.toggle('on', which === 'q');
  if (which === 'q') syncCtxInputs();
}

function dragify(handle, host) {
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
  handle.addEventListener('mousedown', e => {
    if (e.target.id === 'close') return;
    on = true;
    const r = host.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    host.style.right = 'auto'; host.style.bottom = 'auto';
    host.style.left = ox + 'px'; host.style.top = oy + 'px';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!on) return;
    host.style.left = Math.max(0, Math.min(innerWidth - 60, ox + e.clientX - sx)) + 'px';
    host.style.top = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy)) + 'px';
  });
  window.addEventListener('mouseup', () => { on = false; });
}

function log(msg) {
  if (!ui) return;
  const t = new Date().toTimeString().slice(0, 8);
  ui.log.innerHTML += (ui.log.innerHTML ? '\n' : '') + '[' + t + '] ' + msg;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setStat(text, kind) {
  if (!ui) return;
  ui.stat.textContent = text;
  ui.stat.className = 'stat' + (kind ? ' ' + kind : '');
}

function doScan() {
  const rows = collect();
  const matched = rows.filter(r => r.key);
  ui.list.innerHTML = rows.length === 0
    ? '<div class="r"><span class="v none">本页没有可填写的输入框</span></div>'
    : rows.map(r => `<div class="r"><span class="k" title="${esc(r.label)}">${esc(r.label)}</span>` +
      `<span class="v${r.key ? '' : ' none'}">${esc(r.key ? (r.value || '(档案里是空值)') : '未识别')}</span>` +
      `<span class="s ${r.filled ? 'ok' : (r.key ? '' : 'warn')}">${r.filled ? '已填' : (r.key ? (r.has ? '已有内容' : '待填') : '—')}</span></div>`).join('');
  setStat('识别 ' + rows.length + ' 个字段', 'ok');
  log('扫描完成：可填 ' + rows.length + ' 个，其中识别出 ' + matched.length + ' 个，未识别 ' + (rows.length - matched.length) + ' 个');
}

function doFill() {
  if (!PROFILE) { log('✖ 字段档案还没载入，点右上角 ✕ 关掉面板重开一次'); return; }
  const overwrite = ui.$('#overwrite').checked;
  const rep = fillAll(overwrite);
  doScan();
  setStat('已填 ' + rep.filled + ' 个', 'ok');
  log('填入完成：写入 ' + rep.filled + ' 个 · 跳过已有内容 ' + rep.skippedHas + ' 个 · 未识别 ' + rep.noKey +
      ' 个 · 档案空值 ' + rep.empty + ' 个' + (rep.failed.length ? ' · 写入失败 ' + rep.failed.length + ' 个：' + rep.failed.slice(0, 3).join('、') : ''));
  log('提醒：简历 PDF 之类的上传框、单选/多选组仍需你手动处理；填完请自己复核再点提交。');
  // 自动留痕：同一网址重复填只更新同一条，不会刷屏
  if (rep.filled > 0) {
    pushTracker('待投递', rep.filled).then(r => {
      if (r.ok) log('📋 已记入「④ 投递进度」：' + (CTX.company || location.host) + ' · 待投递（提交后点「记一笔投递」改状态）');
    });
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ============================================================
   问答题：识别答不上来的长问题 → 交给本机工作台按经历库生成
   ============================================================ */
const Q_RE = /why|describe|tell us|explain|motivat|how would|example|walk us|share|elaborate|summary|yourself|interest|为什么|原因|请描述|简述|介绍|谈谈|举例|说明|自我评价|职业规划|如何看待|怎么理解|你最大的|是否了解/i;

// 只挑「不是基础字段 + 是长文本或像问答题」的控件
function questionFields() {
  const out = [];
  for (const el of document.querySelectorAll('textarea,input')) {
    if (el.tagName === 'INPUT' && !['text', '', 'search'].includes((el.type || 'text').toLowerCase())) continue;
    if (el.disabled || el.readOnly || !isVisible(el)) continue;
    const blob = labelBlob(el);
    if (SKIP_RE.test(blob)) continue;
    if (matchField(blob)) continue;            // 基础字段归「填入」管
    const max = parseInt(el.getAttribute('maxlength') || '0', 10) || 0;
    const isArea = el.tagName === 'TEXTAREA';
    const label = prettyLabel(el);
    if (!isArea && !(max > 60 && Q_RE.test(label + ' ' + blob))) continue;
    out.push({ el, label, max, has: hasValue(el), answer: '', busy: false, src: '' });
  }
  return out;
}

let QLIST = [];
let CTX = { company: '', title: '', jd: '' };

function guessCompany() {
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og && og.getAttribute('content')) return og.getAttribute('content').trim().slice(0, 60);
  const h1 = document.querySelector('h1');
  if (h1 && h1.innerText.trim()) return h1.innerText.trim().split('\n')[0].slice(0, 60);
  const t = (document.title || '').split(/[|\-–—·]/)[0].trim();
  return t || location.hostname;
}

function ctxKey() { return 'ctx:' + location.hostname; }
async function loadCtx() {
  try {
    const st = await chrome.storage.local.get(ctxKey());
    if (st && st[ctxKey()]) CTX = Object.assign(CTX, st[ctxKey()]);
  } catch (e) {}
  if (!CTX.company) CTX.company = guessCompany();
  if (!CTX.title) {
    const h1 = document.querySelector('h1');
    if (h1) CTX.title = h1.innerText.trim().split('\n').pop().slice(0, 60);
  }
}
function saveCtx() { try { const o = {}; o[ctxKey()] = CTX; chrome.storage.local.set(o); } catch (e) {} }

function syncCtxInputs() {
  if (!ui) return;
  const c = ui.$('#ctx-company'), t = ui.$('#ctx-title'), j = ui.$('#ctx-jd');
  if (!c) return;
  c.value = CTX.company || '';
  t.value = CTX.title || '';
  j.value = CTX.jd || '';
  if (!c.dataset.bound) {
    c.dataset.bound = '1';
    c.oninput = () => { CTX.company = c.value; saveCtx(); };
    t.oninput = () => { CTX.title = t.value; saveCtx(); };
    j.oninput = () => { CTX.jd = j.value; saveCtx(); };
  }
}

function doQuestionScan() {
  QLIST = questionFields();
  renderQs();
  if (QLIST.length) {
    switchPane('q');
    log('找出 ' + QLIST.length + ' 道待答问题' + (QLIST.some(q => q.has) ? '（其中 ' + QLIST.filter(q => q.has).length + ' 个已有内容）' : ''));
  } else {
    log('这一页没找到需要生成的长问答题');
  }
}

function renderQs() {
  if (!ui) return;
  syncCtxInputs();
  if (!QLIST.length) {
    ui.qs.innerHTML = '<div class="empty">还没有待答问题。点上面的「🔍 找出问答题」。</div>';
    return;
  }
  ui.qs.innerHTML = QLIST.map((q, i) => {
    const len = q.answer.length;
    const over = q.max && len > q.max;
    const counter = q.answer ? `<span class="cc${over ? ' over' : ''}">${len}${q.max ? ' / ' + q.max : ''}</span>` : '';
    const src = q.src ? `<div class="src">${esc(q.src)}</div>` : '';
    return `<div class="q">
      <div class="qt">${esc(q.label)}</div>
      <div class="qm">${q.max ? '表单上限 ' + q.max + ' 字符' : '未设字数上限'}${q.has ? ' · 已有内容（填入会覆盖）' : ''}</div>
      <textarea data-qi="${i}" placeholder="${q.busy ? '正在生成…' : '点下面「生成」'}"${q.busy ? ' disabled' : ''}>${esc(q.answer)}</textarea>
      ${src}
      <div class="qb">
        <button class="p" data-act="gen" data-qi="${i}"${q.busy ? ' disabled' : ''}>${q.answer ? '↻ 重生成' : '✨ 生成'}</button>
        ${q.answer ? `<button data-act="diff" data-qi="${i}">🔀 换角度</button>
                      <button data-act="short" data-qi="${i}">✂️ 缩短</button>
                      <button data-act="put" data-qi="${i}">⬇ 填入页面</button>
                      <button data-act="save" data-qi="${i}">⭐ 存为常用</button>` : ''}
        ${counter}
      </div>
    </div>`;
  }).join('');

  ui.qs.querySelectorAll('textarea[data-qi]').forEach(t => {
    t.oninput = () => { const q = QLIST[+t.dataset.qi]; q.answer = t.value; updateCounter(+t.dataset.qi); };
  });
  ui.qs.querySelectorAll('button[data-act]').forEach(b => {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => qAct(b.dataset.act, +b.dataset.qi);
  });
}

function updateCounter(i) {
  const q = QLIST[i];
  const box = ui.qs.querySelector('textarea[data-qi="' + i + '"]');
  if (!box) return;
  const wrap = box.closest('.q');
  const cc = wrap.querySelector('.cc');
  if (!cc) return;
  const len = q.answer.length;
  cc.textContent = len + (q.max ? ' / ' + q.max : '');
  cc.classList.toggle('over', !!(q.max && len > q.max));
}

async function qAct(act, i) {
  const q = QLIST[i];
  if (!q) return;
  if (act === 'put') {
    try {
      setNative(q.el, q.answer);
      q.el.classList.add(HL);
      q.el.dataset.jobappSrc = 'AI 问答';
      q.el.setAttribute('title', '网申助手生成：' + q.label.slice(0, 40));
      injectHl();
      log('已填入：「' + q.label.slice(0, 24) + '…」 ' + q.answer.length + ' 字符' + (q.max && q.answer.length > q.max ? '（超出表单上限 ' + q.max + '，表单可能截断）' : ''));
    } catch (e) { log('✖ 填入失败：' + e.message); }
    return;
  }
  if (act === 'save') {
    const r = await bg({ type: 'jobapp-api', path: '/api/apply/save-answer', method: 'POST', body: { question: q.label, answer: q.answer, used: q.used || [] } });
    log(r.ok ? '⭐ 已存为常用答案，下次遇到同一题直接复用（不花 token）' : '✖ 保存失败：' + r.error);
    return;
  }

  const angle = act === 'diff' ? 'different' : act === 'short' ? 'concise' : '';
  q.busy = true; renderQs();
  log((angle === 'different' ? '换角度' : angle === 'concise' ? '缩短' : '生成') + '中：「' + q.label.slice(0, 24) + '…」');

  const r = await bg({
    type: 'jobapp-api', path: '/api/apply/answer', method: 'POST',
    body: {
      question: q.label, maxLength: q.max || 0, company: CTX.company, title: CTX.title,
      jd: CTX.jd, lang: ZH_PAGE ? 'zh' : 'en', angle: angle, force: !!angle
    }
  });
  q.busy = false;
  if (!r.ok || !r.data || r.data.error) {
    const msg = (r.data && r.data.error) || r.error || '未知错误';
    q.answer = q.answer || '';
    renderQs();
    log('✖ 生成失败：' + msg);
    return;
  }
  q.answer = r.data.answer;
  q.used = r.data.used || [];
  q.src = r.data.cached ? '来自你存过的常用答案'
    : '依据：' + (r.data.used || []).slice(0, 3).join(' / ') + ((r.data.used || []).length > 3 ? ' 等 ' + r.data.used.length + ' 条' : '');
  renderQs();
  log('✔ 生成完成 ' + r.data.chars + ' 字符' + (r.data.cap ? ' / 上限 ' + r.data.cap : '') +
    (r.data.shrunk ? '（已自动压缩过）' : '') + (r.data.over ? ' ⚠ 仍超上限，建议手动删几句' : ''));
}

// 把这一页的公司/职位/JD/问答写进工作台「④ 投递进度」。
// status='待投递' 用于「填入页面」自动留痕；status='已投递' 是你点「记一笔投递」时明确宣告已提交。
async function pushTracker(status, questions) {
  const r = await bg({
    type: 'jobapp-api', path: '/api/apply/log', method: 'POST',
    body: {
      url: location.href, company: CTX.company, title: CTX.title,
      jd: CTX.jd || '', status: status,
      filled: typeof questions === 'number' ? questions : null,
      questions: Array.isArray(questions) ? questions : []
    }
  });
  return r;
}

// 记一笔投递：公司/职位/JD + 这一页答过的问题
async function logApply() {
  const qs = QLIST.filter(q => q.answer).map(q => ({ q: q.label, a: q.answer }));
  const rep = fillAll(false);
  const r = await pushTracker('已投递', qs);
  if (r.ok) log('📋 已记入「④ 投递进度」：' + (CTX.company || location.host) + ' · 状态已投递'
    + (r.data && r.data.trackerId ? '' : '') + (qs.length ? ' · 带 ' + qs.length + ' 条问答' : ''));
  else log('✖ 记录失败：' + r.error);
}

/* ---------------- 启动 ---------------- */
// 全部延后到页面 load 之后异步执行，且任何异常都被吞掉，绝不影响网页本身。
// 有些招聘站（北森/智联等 SPA）对注入时机敏感，同步插 DOM 会搅乱它们的启动时序。
function recoveryDot(host) {
  const d = document.createElement('div');
  d.title = '网申助手已在此网站停用，点击恢复';
  d.style.cssText = 'all:initial;position:fixed;right:10px;bottom:10px;width:14px;height:14px;border-radius:50%;background:rgba(120,130,150,.4);cursor:pointer;z-index:2147483647';
  (document.body || document.documentElement).appendChild(d);
  d.addEventListener('click', async () => { await setHostDisabled(host, false); location.reload(); });
}
function boot() {
  const host = location.hostname;
  disabledHosts().then(async (disabled) => {
    if (disabled.indexOf(host) >= 0) { try { recoveryDot(host); } catch (e) {} return; }
    try { buildPanel(); } catch (e) { return; }
    log('扩展已加载：' + host);
    try {
      const r = await loadProfile();
      await loadCtx();
      if (r.ok) {
        setStat('已连接本机服务', 'ok');
        log('✔ 字段档案载入成功（' + Object.keys(PROFILE).filter(k => PROFILE[k]).length + ' 项有值）');
        if (!PROFILE.email && !PROFILE.fullName) log('⚠ 档案几乎是空的，请先在工作台的「⑥ 网申助手」里填写');
      } else {
        setStat('未连接本机服务', 'err');
        log('✖ ' + r.error);
        log('请确认 node server.js 正在运行，然后刷新本页。');
      }
    } catch (e) { log('✖ 载入出错：' + ((e && e.message) || e)); }
  });
}
if (document.readyState === 'complete') setTimeout(boot, 0);
else window.addEventListener('load', () => setTimeout(boot, 0));
})();
