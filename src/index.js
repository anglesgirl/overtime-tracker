/**
 * 加班打卡系统 - Cloudflare Worker
 * 单文件包含：路由、API、静态页面服务
 */

// ===== 工具函数 =====

function uuid() {
  return crypto.randomUUID();
}

async function hashPassword(password) {
  const data = new TextEncoder().encode('overtime_salt_' + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 从请求头获取 token
function getToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return auth;
}

// 验证 token，返回用户信息
async function getUser(env, request) {
  const token = getToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.* FROM users u JOIN sessions s ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime(\'now\')'
  ).bind(token).first();
  return row;
}

// 判断日期类型
async function getDayType(env, dateStr) {
  // 先查节假日表
  const holiday = await env.DB.prepare(
    'SELECT type FROM holidays WHERE date = ?'
  ).bind(dateStr).first();

  if (holiday) {
    return holiday.type; // 'holiday' or 'workday'
  }

  // 没有特殊设置，按周末判断
  const date = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = date.getDay(); // 0=周日, 6=周六
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 'weekend';
  }
  return 'workday';
}

// 计算加班时长（小时）
// 逻辑：加班开始时间 → 下班时间，扣除完全包含在加班时段内的休息时间
// overtimeStart 不填时用 standardOffTime（工作日下班后加班的默认行为）
function calcOvertimeHours(offTime, standardOffTime, overtimeStart, breaks) {
  const [oh, om] = offTime.split(':').map(Number);
  const endMinutes = oh * 60 + om;

  // 加班开始时间：填了用填的，没填用标准下班时间
  const startStr = overtimeStart || standardOffTime;
  const [sh, sm] = startStr.split(':').map(Number);
  const startMinutes = sh * 60 + sm;

  // 只扣除完全包含在加班时段内的休息时间（部分重叠不扣）
  let totalBreak = 0;
  for (const b of breaks) {
    if (!b || !b.start || !b.end) continue;
    const [bh, bm] = b.start.split(':').map(Number);
    const [eh, em] = b.end.split(':').map(Number);
    const bS = bh * 60 + bm;
    const bE = eh * 60 + em;
    // 休息时段完全在加班时段内才扣除
    if (bS >= startMinutes && bE <= endMinutes) {
      totalBreak += (bE - bS);
    }
  }

  const diff = endMinutes - startMinutes - totalBreak;
  if (diff <= 0) return 0;
  return Math.round(diff / 15) * 15 / 60; // 按15分钟取整
}

// 构建休息时间数组
function buildBreaks(lunchStart, lunchEnd, dinnerStart, dinnerEnd) {
  const breaks = [];
  if (lunchStart && lunchEnd) breaks.push({ start: lunchStart, end: lunchEnd });
  if (dinnerStart && dinnerEnd) breaks.push({ start: dinnerStart, end: dinnerEnd });
  return breaks;
}

// 计算加班费
function calcOvertimePay(hours, rate, monthlySalary) {
  if (monthlySalary <= 0 || hours <= 0) return 0;
  const hourlyRate = monthlySalary / 21.75 / 8;
  return Math.round(hours * hourlyRate * rate * 100) / 100;
}

// 根据日期类型获取倍率
function getRate(dayType) {
  switch (dayType) {
    case 'holiday': return 3;
    case 'weekend': return 2;
    default: return 1.5;
  }
}

// 格式化金额
function formatMoney(num) {
  return num.toFixed(2);
}

// ===== 路由处理 =====

async function handleApi(request, env, path) {
  const method = request.method;

  // ----- 认证相关 -----
  if (path === '/api/register' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password) return json({ error: '用户名和密码不能为空' }, 400);
    if (username.length < 2) return json({ error: '用户名至少2个字符' }, 400);
    if (password.length < 4) return json({ error: '密码至少4个字符' }, 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (existing) return json({ error: '用户名已存在' }, 400);

    const id = uuid();
    const hashed = await hashPassword(password);
    await env.DB.prepare(
      'INSERT INTO users (id, username, password) VALUES (?, ?, ?)'
    ).bind(id, username, hashed).run();

    return json({ success: true, message: '注册成功，请登录' });
  }

  if (path === '/api/login' && method === 'POST') {
    const { username, password } = await request.json();
    const hashed = await hashPassword(password);
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND password = ?'
    ).bind(username, hashed).first();

    if (!user) return json({ error: '用户名或密码错误' }, 401);

    const token = uuid();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(token, user.id, expires).run();

    return json({
      token,
      user: { id: user.id, username: user.username },
    });
  }

  // 以下接口需要登录
  const user = await getUser(env, request);
  if (!user) return json({ error: '未登录或登录已过期' }, 401);

  // ----- 用户设置 -----
  if (path === '/api/settings' && method === 'GET') {
    return json({
      username: user.username,
      monthly_salary: user.monthly_salary,
      standard_on_time: user.standard_on_time,
      standard_off_time: user.standard_off_time,
      lunch_start: user.lunch_start || '12:00',
      lunch_end: user.lunch_end || '13:00',
      dinner_start: user.dinner_start || '17:30',
      dinner_end: user.dinner_end || '18:30',
    });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const { monthly_salary, standard_on_time, standard_off_time, lunch_start, lunch_end, dinner_start, dinner_end } = await request.json();
    const newSalary = monthly_salary || 0;
    const newOffTime = standard_off_time || '18:00';
    const newLunchStart = lunch_start || '12:00';
    const newLunchEnd = lunch_end || '13:00';
    const newDinnerStart = dinner_start || '17:30';
    const newDinnerEnd = dinner_end || '18:30';
    const userBreaks = buildBreaks(newLunchStart, newLunchEnd, newDinnerStart, newDinnerEnd);

    await env.DB.prepare(
      'UPDATE users SET monthly_salary = ?, standard_on_time = ?, standard_off_time = ?, lunch_start = ?, lunch_end = ?, dinner_start = ?, dinner_end = ? WHERE id = ?'
    ).bind(newSalary, standard_on_time || '09:00', newOffTime, newLunchStart, newLunchEnd, newDinnerStart, newDinnerEnd, user.id).run();

    // 重新计算该用户所有加班记录的时长和金额
    const { results: allRecords } = await env.DB.prepare(
      'SELECT * FROM overtime_records WHERE user_id = ?'
    ).bind(user.id).all();

    for (const r of allRecords) {
      const newHours = calcOvertimeHours(r.off_time, newOffTime, r.overtime_start || null, userBreaks);
      // rate 不变（调休的保持1，其他的保持原倍率）
      const newPay = calcOvertimePay(newHours, r.rate, newSalary);
      await env.DB.prepare(
        'UPDATE overtime_records SET overtime_hours = ?, overtime_pay = ? WHERE id = ?'
      ).bind(newHours, newPay, r.id).run();
    }

    return json({ success: true, recalculated: allRecords.length });
  }

  // ----- 加班打卡 -----
  if (path === '/api/overtime' && method === 'POST') {
    const { date, off_time, overtime_start, note } = await request.json();
    if (!date || !off_time) return json({ error: '日期和下班时间不能为空' }, 400);

    // 检查是否已有记录
    const existing = await env.DB.prepare(
      'SELECT id FROM overtime_records WHERE user_id = ? AND date = ?'
    ).bind(user.id, date).first();
    if (existing) return json({ error: '该日期已有加班记录' }, 400);

    const dayType = await getDayType(env, date);
    const rate = getRate(dayType);
    const userBreaks = buildBreaks(user.lunch_start || '12:00', user.lunch_end || '13:00', user.dinner_start || '17:30', user.dinner_end || '18:30');
    const hours = calcOvertimeHours(off_time, user.standard_off_time, overtime_start || null, userBreaks);
    const pay = calcOvertimePay(hours, rate, user.monthly_salary);

    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO overtime_records (id, user_id, date, off_time, overtime_start, overtime_hours, day_type, rate, overtime_pay, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, date, off_time, overtime_start || null, hours, dayType, rate, pay, note || '').run();

    const record = await env.DB.prepare('SELECT * FROM overtime_records WHERE id = ?').bind(id).first();
    return json({ success: true, record });
  }

  // 查询加班记录（含调休信息）
  if (path === '/api/overtime' && method === 'GET') {
    const url = new URL(request.url);
    const month = url.searchParams.get('month'); // YYYY-MM
    let query, params;
    if (month) {
      query = `SELECT o.*, c.comp_off_date, c.id as comp_off_id
               FROM overtime_records o
               LEFT JOIN comp_off_records c ON c.overtime_record_id = o.id
               WHERE o.user_id = ? AND o.date LIKE ? ORDER BY o.date DESC`;
      params = [user.id, month + '%'];
    } else {
      query = `SELECT o.*, c.comp_off_date, c.id as comp_off_id
               FROM overtime_records o
               LEFT JOIN comp_off_records c ON c.overtime_record_id = o.id
               WHERE o.user_id = ? ORDER BY o.date DESC LIMIT 30`;
      params = [user.id];
    }
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return json({ records: results });
  }

  // 修改加班记录
  if (path.startsWith('/api/overtime/') && method === 'PUT') {
    const id = path.split('/')[3];
    const { off_time, overtime_start, note } = await request.json();
    if (!off_time) return json({ error: '下班时间不能为空' }, 400);

    const record = await env.DB.prepare(
      'SELECT * FROM overtime_records WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).first();
    if (!record) return json({ error: '记录不存在' }, 400);

    const otStart = overtime_start !== undefined ? (overtime_start || null) : (record.overtime_start || null);
    const userBreaks = buildBreaks(user.lunch_start || '12:00', user.lunch_end || '13:00', user.dinner_start || '17:30', user.dinner_end || '18:30');
    const newHours = calcOvertimeHours(off_time, user.standard_off_time, otStart, userBreaks);
    const newPay = calcOvertimePay(newHours, record.rate, user.monthly_salary);

    await env.DB.prepare(
      'UPDATE overtime_records SET off_time = ?, overtime_start = ?, overtime_hours = ?, overtime_pay = ?, note = ? WHERE id = ?'
    ).bind(off_time, otStart, newHours, newPay, note !== undefined ? note : record.note, id).run();

    const updated = await env.DB.prepare(
      `SELECT o.*, c.comp_off_date FROM overtime_records o
       LEFT JOIN comp_off_records c ON c.overtime_record_id = o.id WHERE o.id = ?`
    ).bind(id).first();
    return json({ success: true, record: updated });
  }

  // 删除加班记录
  if (path.startsWith('/api/overtime/') && method === 'DELETE') {
    const id = path.split('/')[3];
    // 检查是否有关联调休
    const compOff = await env.DB.prepare(
      'SELECT id FROM comp_off_records WHERE overtime_record_id = ?'
    ).bind(id).first();
    if (compOff) return json({ error: '该记录已关联调休，请先取消调休' }, 400);

    await env.DB.prepare('DELETE FROM overtime_records WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return json({ success: true });
  }

  // ----- 调休 -----
  if (path === '/api/comp-off' && method === 'POST') {
    const { overtime_record_id, comp_off_date } = await request.json();
    if (!overtime_record_id || !comp_off_date) return json({ error: '缺少参数' }, 400);

    // 查加班记录
    const otRecord = await env.DB.prepare(
      'SELECT * FROM overtime_records WHERE id = ? AND user_id = ?'
    ).bind(overtime_record_id, user.id).first();
    if (!otRecord) return json({ error: '加班记录不存在' }, 400);
    if (otRecord.status === 'comp_off') return json({ error: '该记录已调休' }, 400);

    // 只有休息日(2x)加班可以调休
    if (otRecord.day_type !== 'weekend') {
      return json({ error: '只有休息日加班可以调休' }, 400);
    }

    const id = uuid();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO comp_off_records (id, user_id, comp_off_date, overtime_record_id) VALUES (?, ?, ?, ?)'
      ).bind(id, user.id, comp_off_date, overtime_record_id),
      // 将原加班记录状态改为已调休，倍率降为1（正常工作日）
      env.DB.prepare(
        'UPDATE overtime_records SET status = ?, rate = ?, overtime_pay = ? WHERE id = ?'
      ).bind('comp_off', 1, calcOvertimePay(otRecord.overtime_hours, 1, user.monthly_salary), overtime_record_id),
    ]);

    return json({ success: true, message: '调休成功' });
  }

  // 取消调休
  if (path.startsWith('/api/comp-off/') && method === 'DELETE') {
    const otId = path.split('/')[3];
    const compOff = await env.DB.prepare(
      'SELECT * FROM comp_off_records WHERE overtime_record_id = ? AND user_id = ?'
    ).bind(otId, user.id).first();
    if (!compOff) return json({ error: '调休记录不存在' }, 400);

    const otRecord = await env.DB.prepare('SELECT * FROM overtime_records WHERE id = ?').bind(otId).first();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM comp_off_records WHERE id = ?').bind(compOff.id),
      // 恢复原倍率
      env.DB.prepare(
        'UPDATE overtime_records SET status = ?, rate = ?, overtime_pay = ? WHERE id = ?'
      ).bind('active', 2, calcOvertimePay(otRecord.overtime_hours, 2, user.monthly_salary), otId),
    ]);

    return json({ success: true });
  }

  // ----- 统计 -----
  if (path === '/api/stats' && method === 'GET') {
    const url = new URL(request.url);
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);

    const { results } = await env.DB.prepare(
      'SELECT * FROM overtime_records WHERE user_id = ? AND date LIKE ? ORDER BY date ASC'
    ).bind(user.id, month + '%').all();

    let totalHours = 0, totalPay = 0;
    const byType = { workday: { hours: 0, pay: 0, count: 0 }, weekend: { hours: 0, pay: 0, count: 0 }, holiday: { hours: 0, pay: 0, count: 0 } };
    const byDay = [];

    for (const r of results) {
      totalHours += r.overtime_hours;
      totalPay += r.overtime_pay;
      if (byType[r.day_type]) {
        byType[r.day_type].hours += r.overtime_hours;
        byType[r.day_type].pay += r.overtime_pay;
        byType[r.day_type].count++;
      }
      byDay.push({ date: r.date, hours: r.overtime_hours, pay: r.overtime_pay });
    }

    return json({
      month,
      total_hours: Math.round(totalHours * 100) / 100,
      total_pay: Math.round(totalPay * 100) / 100,
      total_count: results.length,
      by_type: {
        workday: { ...byType.workday, hours: Math.round(byType.workday.hours * 100) / 100, pay: Math.round(byType.workday.pay * 100) / 100 },
        weekend: { ...byType.weekend, hours: Math.round(byType.weekend.hours * 100) / 100, pay: Math.round(byType.weekend.pay * 100) / 100 },
        holiday: { ...byType.holiday, hours: Math.round(byType.holiday.hours * 100) / 100, pay: Math.round(byType.holiday.pay * 100) / 100 },
      },
      daily: byDay,
    });
  }

  // ----- 节假日管理 -----
  if (path === '/api/holidays' && method === 'GET') {
    const url = new URL(request.url);
    const year = url.searchParams.get('year') || new Date().getFullYear();
    const { results } = await env.DB.prepare(
      'SELECT * FROM holidays WHERE date LIKE ? ORDER BY date ASC'
    ).bind(year + '%').all();
    return json({ holidays: results });
  }

  if (path === '/api/holidays' && method === 'POST') {
    const { date, name, type } = await request.json();
    if (!date || !name || !type) return json({ error: '缺少参数' }, 400);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO holidays (date, name, type) VALUES (?, ?, ?)'
    ).bind(date, name, type).run();
    return json({ success: true });
  }

  // ----- 获取日期类型 -----
  if (path === '/api/day-type' && method === 'GET') {
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    if (!date) return json({ error: '缺少日期参数' }, 400);
    const dayType = await getDayType(env, date);
    const rate = getRate(dayType);
    const dayNames = { workday: '工作日', weekend: '休息日', holiday: '法定节假日' };
    return json({ date, day_type: dayType, day_name: dayNames[dayType] || dayType, rate });
  }

  return json({ error: '接口不存在' }, 404);
}

// ===== 前端页面 =====

const HTML_PAGES = {
  '/': 'index',
  '/login': 'login',
  '/settings': 'settings',
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // API 路由
  if (path.startsWith('/api/')) {
    return handleApi(request, env, path);
  }

  // 静态资源
  if (path === '/style.css') {
    return new Response(CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
  }

  // 页面路由
  const pageName = HTML_PAGES[path];
  if (pageName === 'login') {
    return new Response(PAGE_LOGIN, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (pageName === 'settings') {
    return new Response(PAGE_SETTINGS, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (pageName === 'index' || !pageName) {
    return new Response(PAGE_INDEX, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return new Response('Not Found', { status: 404 });
}

// ===== CSS =====
const CSS = `
:root {
  --bg: #0f0f0f;
  --card: #1a1a2e;
  --primary: #6c5ce7;
  --primary-light: #a29bfe;
  --text: #e0e0e0;
  --text-dim: #888;
  --green: #00b894;
  --red: #e74c3c;
  --yellow: #fdcb6e;
  --border: #2a2a4a;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans CJK SC', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  padding-bottom: 80px;
}
.container { max-width: 480px; margin: 0 auto; padding: 16px; }
.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 20px;
}
.header h1 { font-size: 20px; color: var(--primary-light); }
.header a { color: var(--text-dim); text-decoration: none; font-size: 14px; }
.card {
  background: var(--card); border-radius: 12px; padding: 20px;
  margin-bottom: 16px; border: 1px solid var(--border);
}
.card h2 { font-size: 16px; margin-bottom: 16px; color: var(--primary-light); }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 14px; color: var(--text-dim); margin-bottom: 6px; }
.form-group input, .form-group select {
  width: 100%; padding: 12px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); font-size: 16px;
}
.form-group input:focus { outline: none; border-color: var(--primary); }
.btn {
  display: block; width: 100%; padding: 14px; border: none;
  border-radius: 8px; font-size: 16px; font-weight: 600;
  cursor: pointer; transition: opacity .2s;
}
.btn:active { opacity: 0.8; }
.btn-primary { background: var(--primary); color: white; }
.btn-danger { background: var(--red); color: white; }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
.btn + .btn { margin-top: 8px; }
.summary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.summary-item { text-align: center; }
.summary-item .value { font-size: 28px; font-weight: 700; }
.summary-item .label { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.green { color: var(--green); }
.yellow { color: var(--yellow); }
.red { color: var(--red); }
.record {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid var(--border);
}
.record:last-child { border-bottom: none; }
.record-info { flex: 1; }
.record-date { font-size: 15px; font-weight: 600; }
.record-detail { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.record-pay { text-align: right; }
.record-pay .amount { font-size: 16px; font-weight: 600; color: var(--green); }
.record-pay .hours { font-size: 12px; color: var(--text-dim); }
.tag {
  display: inline-block; padding: 2px 8px; border-radius: 4px;
  font-size: 11px; margin-left: 6px;
}
.tag-workday { background: rgba(108,92,231,.2); color: var(--primary-light); }
.tag-weekend { background: rgba(253,203,110,.2); color: var(--yellow); }
.tag-holiday { background: rgba(231,76,60,.2); color: var(--red); }
.tag-compoff { background: rgba(0,184,148,.2); color: var(--green); }
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  display: flex; background: var(--card); border-top: 1px solid var(--border);
  z-index: 100; max-width: 480px; margin: 0 auto;
}
.nav-item {
  flex: 1; text-align: center; padding: 12px 0;
  color: var(--text-dim); text-decoration: none; font-size: 12px;
}
.nav-item.active { color: var(--primary-light); }
.nav-item .icon { font-size: 20px; display: block; margin-bottom: 2px; }
.empty { text-align: center; padding: 40px 0; color: var(--text-dim); }
.toast {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  background: var(--card); padding: 12px 24px; border-radius: 8px;
  border: 1px solid var(--border); z-index: 200; display: none;
  font-size: 14px;
}
.toast.show { display: block; animation: fadeIn .3s; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.record-actions { display: flex; gap: 6px; margin-top: 6px; }
.btn-sm {
  padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer;
}
.btn-sm:hover { border-color: var(--primary); color: var(--primary-light); }
.btn-sm.danger { color: var(--red); border-color: rgba(231,76,60,.3); }
.compoff-info {
  font-size: 12px; color: var(--green); margin-top: 4px;
}
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,.6); z-index: 300;
  display: none; align-items: center; justify-content: center;
}
.modal-overlay.show { display: flex; }
.modal {
  background: var(--card); border-radius: 12px; padding: 24px;
  width: 90%; max-width: 360px; border: 1px solid var(--border);
}
.modal h3 { font-size: 16px; color: var(--primary-light); margin-bottom: 16px; }
.modal .btn { margin-top: 8px; }
`;

// ===== 登录页 =====
const PAGE_LOGIN = `
<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>加班打卡 - 登录</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="container">
<div class="header"><h1>加班打卡</h1></div>
<div class="card">
  <h2 id="title">登录</h2>
  <div class="form-group"><label>用户名</label>
    <input id="username" type="text" placeholder="输入用户名"></div>
  <div class="form-group"><label>密码</label>
    <input id="password" type="password" placeholder="输入密码"></div>
  <button class="btn btn-primary" id="submitBtn">登录</button>
  <button class="btn btn-outline" id="switchBtn">没有账号？去注册</button>
</div>
</div>
<div class="toast" id="toast"></div>
<script>
let isLogin = true;
const token = localStorage.getItem('token');
if (token) location.href = '/';

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

document.getElementById('switchBtn').onclick = () => {
  isLogin = !isLogin;
  document.getElementById('title').textContent = isLogin ? '登录' : '注册';
  document.getElementById('submitBtn').textContent = isLogin ? '登录' : '注册';
  document.getElementById('switchBtn').textContent = isLogin ? '没有账号？去注册' : '已有账号？去登录';
};

document.getElementById('submitBtn').onclick = async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!username || !password) { showToast('请填写用户名和密码'); return; }

  const api = isLogin ? '/api/login' : '/api/register';
  const res = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();

  if (!res.ok) { showToast(data.error || '操作失败'); return; }
  if (isLogin) {
    localStorage.setItem('token', data.token);
    location.href = '/';
  } else {
    showToast('注册成功，请登录');
    isLogin = true;
    document.getElementById('title').textContent = '登录';
    document.getElementById('submitBtn').textContent = '登录';
    document.getElementById('switchBtn').textContent = '没有账号？去注册';
  }
};
</script></body></html>
`;

// ===== 设置页 =====
const PAGE_SETTINGS = `
<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>设置 - 加班打卡</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="container">
<div class="header">
  <h1>设置</h1>
  <a href="/">返回</a>
</div>
<div class="card">
  <h2>个人信息</h2>
  <div class="form-group"><label>用户名</label>
    <input id="username" type="text" disabled></div>
  <div class="form-group"><label>月基本工资（元）</label>
    <input id="salary" type="number" placeholder="如 8000"></div>
  <div class="form-group"><label>标准上班时间</label>
    <input id="onTime" type="time" value="09:00"></div>
  <div class="form-group"><label>标准下班时间</label>
    <input id="offTime" type="time" value="18:00"></div>
  <div class="form-group"><label>午休开始时间</label>
    <input id="lunchStart" type="time" value="12:00"></div>
  <div class="form-group"><label>午休结束时间</label>
    <input id="lunchEnd" type="time" value="13:00"></div>
  <div class="form-group"><label>晚餐休息开始时间</label>
    <input id="dinnerStart" type="time" value="17:30"></div>
  <div class="form-group"><label>晚餐休息结束时间</label>
    <input id="dinnerEnd" type="time" value="18:30"></div>
  <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px">
    午休和晚餐时间用于周末/节假日全天加班时自动扣除。如8:00-21:00会扣掉午休1h+晚餐1h=10h实际加班
  </div>
  <button class="btn btn-primary" id="saveBtn">保存设置</button>
</div>
<div class="card">
  <h2>加班费规则</h2>
  <div style="font-size:14px;line-height:2;color:var(--text-dim)">
    工作日加班：1.5倍时薪<br>
    休息日加班：2倍时薪<br>
    法定节假日加班：3倍时薪<br>
    <br>
    时薪 = 月薪 ÷ 21.75 ÷ 8<br>
    休息日加班可调休，调休后按1倍计算
  </div>
</div>
<div class="card">
  <h2>节假日管理</h2>
  <div id="holidayList"></div>
  <div class="form-group" style="margin-top:16px">
    <label>添加/修改节假日</label>
    <input id="hDate" type="date" style="margin-bottom:8px">
    <input id="hName" type="text" placeholder="名称(如:国庆节)" style="margin-bottom:8px">
    <select id="hType" style="margin-bottom:8px">
      <option value="holiday">法定放假</option>
      <option value="workday">调休补班</option>
    </select>
    <button class="btn btn-outline" id="addHolidayBtn">添加</button>
  </div>
</div>
<button class="btn btn-danger" id="logoutBtn">退出登录</button>
</div>
<div class="toast" id="toast"></div>
<script>
function getToken() { return localStorage.getItem('token'); }
if (!getToken()) location.href = '/login';

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...opts.headers, 'Authorization': 'Bearer ' + getToken() },
  });
  if (res.status === 401) { location.href = '/login'; return null; }
  return res.json();
}

// 加载设置
(async () => {
  const data = await api('/api/settings');
  if (!data) return;
  document.getElementById('username').value = data.username;
  document.getElementById('salary').value = data.monthly_salary || '';
  document.getElementById('onTime').value = data.standard_on_time || '09:00';
  document.getElementById('offTime').value = data.standard_off_time || '18:00';
  document.getElementById('lunchStart').value = data.lunch_start || '12:00';
  document.getElementById('lunchEnd').value = data.lunch_end || '13:00';
  document.getElementById('dinnerStart').value = data.dinner_start || '17:30';
  document.getElementById('dinnerEnd').value = data.dinner_end || '18:30';
})();

// 加载节假日
async function loadHolidays() {
  const data = await api('/api/holidays');
  if (!data || !data.holidays) return;
  const html = data.holidays.map(h =>
    '<div class="record"><div class="record-info"><div class="record-date">' +
    h.date + ' <span class="tag ' + (h.type==='holiday'?'tag-holiday':'tag-workday') + '">' +
    (h.type==='holiday'?'放假':'补班') + '</span></div><div class="record-detail">' +
    h.name + '</div></div></div>'
  ).join('');
  document.getElementById('holidayList').innerHTML = html || '<div class="empty">暂无节假日设置</div>';
}
loadHolidays();

document.getElementById('saveBtn').onclick = async () => {
  const data = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monthly_salary: parseFloat(document.getElementById('salary').value) || 0,
      standard_on_time: document.getElementById('onTime').value,
      standard_off_time: document.getElementById('offTime').value,
      lunch_start: document.getElementById('lunchStart').value,
      lunch_end: document.getElementById('lunchEnd').value,
      dinner_start: document.getElementById('dinnerStart').value,
      dinner_end: document.getElementById('dinnerEnd').value,
    }),
  });
  if (data && data.success) showToast('保存成功' + (data.recalculated > 0 ? '，已重新计算 ' + data.recalculated + ' 条记录' : ''));
};

document.getElementById('addHolidayBtn').onclick = async () => {
  const date = document.getElementById('hDate').value;
  const name = document.getElementById('hName').value;
  const type = document.getElementById('hType').value;
  if (!date || !name) { showToast('请填写完整'); return; }
  const data = await api('/api/holidays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, name, type }),
  });
  if (data && data.success) { showToast('添加成功'); loadHolidays(); }
};

document.getElementById('logoutBtn').onclick = () => {
  localStorage.removeItem('token');
  location.href = '/login';
};
</script></body></html>
`;

// ===== 主页（打卡+记录+统计） =====
const PAGE_INDEX = `
<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>加班打卡</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="container">
<div class="header">
  <h1>加班打卡</h1>
  <a href="/settings">设置</a>
</div>

<!-- 今日打卡 -->
<div class="card">
  <h2>记录加班</h2>
  <div class="form-group">
    <label>日期</label>
    <input id="punchDate" type="date">
  </div>
  <div id="todayInfo" style="margin-bottom:16px;font-size:14px;color:var(--text-dim)"></div>
  <div class="form-group">
    <label>下班时间</label>
    <input id="offTime" type="time">
  </div>
  <div class="form-group">
    <label>加班开始时间（可选）</label>
    <input id="overtimeStart" type="time">
    <div style="font-size:12px;color:var(--text-dim);margin-top:4px">不填则从标准下班时间算。周末全天加班填上班时间（如08:00），系统自动扣午休和晚餐</div>
  </div>
  <div class="form-group">
    <label>备注（可选）</label>
    <input id="note" type="text" placeholder="如：赶项目进度">
  </div>
  <button class="btn btn-primary" id="punchBtn">记录加班</button>
</div>

<!-- 本月统计 -->
<div class="card">
  <h2>本月统计</h2>
  <div class="summary">
    <div class="summary-item">
      <div class="value green" id="totalHours">0</div>
      <div class="label">加班时长(小时)</div>
    </div>
    <div class="summary-item">
      <div class="value yellow" id="totalPay">¥0</div>
      <div class="label">加班费(元)</div>
    </div>
  </div>
</div>

<!-- 分类统计 -->
<div class="card">
  <h2>分类统计</h2>
  <div id="typeStats"></div>
</div>

<!-- 加班记录 -->
<div class="card">
  <h2>加班记录</h2>
  <div id="recordList"></div>
</div>

</div>

<!-- 调休弹窗 -->
<div class="modal-overlay" id="compoffModal">
  <div class="modal">
    <h3>调休操作</h3>
    <div id="compoffOvertimeInfo" style="font-size:14px;color:var(--text-dim);margin-bottom:16px"></div>
    <div class="form-group"><label>调休日期（休息的那天）</label>
      <input id="compoffDate" type="date">
    </div>
    <button class="btn btn-primary" id="confirmCompoffBtn">确认调休</button>
    <button class="btn btn-outline" id="cancelCompoffBtn">取消</button>
  </div>
</div>

<!-- 编辑弹窗 -->
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h3>编辑加班记录</h3>
    <div class="form-group"><label>下班时间</label>
      <input id="editOffTime" type="time">
    </div>
    <div class="form-group"><label>加班开始时间（可选）</label>
      <input id="editOvertimeStart" type="time">
    </div>
    <div class="form-group"><label>备注</label>
      <input id="editNote" type="text" placeholder="如：赶项目进度">
    </div>
    <button class="btn btn-primary" id="confirmEditBtn">保存修改</button>
    <button class="btn btn-outline" id="cancelEditBtn">取消</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function getToken() { return localStorage.getItem('token'); }
if (!getToken()) location.href = '/login';

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const monthStr = todayStr.slice(0, 7);
const nowTime = String(today.getHours()).padStart(2,'0') + ':' + String(today.getMinutes()).padStart(2,'0');

// 下班时间默认当前时间，加班开始时间从 localStorage 记忆，日期默认今天
document.getElementById('punchDate').value = todayStr;
document.getElementById('offTime').value = nowTime;
document.getElementById('overtimeStart').value = localStorage.getItem('overtimeStart') || '';

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...opts.headers, 'Authorization': 'Bearer ' + getToken() },
  });
  if (res.status === 401) { location.href = '/login'; return null; }
  return res.json();
}

const dayNames = { workday: '工作日', weekend: '休息日', holiday: '法定节假日' };
const rateNames = { 1.5: '1.5倍', 2: '2倍', 3: '3倍', 1: '1倍(调休)' };

// 加载选中日期的信息
async function loadDayInfo(dateStr) {
  const data = await api('/api/day-type?date=' + dateStr);
  if (!data) return;
  document.getElementById('todayInfo').innerHTML =
    dateStr + ' · ' + data.day_name + ' · ' + rateNames[data.rate] + '时薪';
}
loadDayInfo(todayStr);

// 日期变化时更新提示
document.getElementById('punchDate').onchange = () => {
  loadDayInfo(document.getElementById('punchDate').value);
};

// 打卡
document.getElementById('punchBtn').onclick = async () => {
  const punchDate = document.getElementById('punchDate').value;
  const offTime = document.getElementById('offTime').value;
  const overtimeStart = document.getElementById('overtimeStart').value;
  const note = document.getElementById('note').value;
  if (!punchDate) { showToast('请选择日期'); return; }
  if (!offTime) { showToast('请选择下班时间'); return; }

  // 记忆加班开始时间
  if (overtimeStart) localStorage.setItem('overtimeStart', overtimeStart); else localStorage.removeItem('overtimeStart');

  const data = await api('/api/overtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: punchDate, off_time: offTime, overtime_start: overtimeStart || null, note }),
  });

  if (!data) return;
  if (data.error) { showToast(data.error); return; }

  if (data.record.overtime_hours > 0) {
    showToast('打卡成功！加班 ' + data.record.overtime_hours + ' 小时，加班费 ¥' + data.record.overtime_pay.toFixed(2));
  } else {
    showToast('记录成功，今天没有加班');
  }
  loadRecords();
  loadStats();
};

// 加载统计
async function loadStats() {
  const data = await api('/api/stats?month=' + monthStr);
  if (!data) return;
  document.getElementById('totalHours').textContent = data.total_hours;
  document.getElementById('totalPay').textContent = '¥' + data.total_pay.toFixed(2);

  let typeHtml = '';
  const types = [
    { key: 'workday', name: '工作日 (1.5倍)', color: 'green' },
    { key: 'weekend', name: '休息日 (2倍)', color: 'yellow' },
    { key: 'holiday', name: '节假日 (3倍)', color: 'red' },
  ];
  for (const t of types) {
    const d = data.by_type[t.key];
    typeHtml += '<div class="record"><div class="record-info"><div class="record-date">' +
      t.name + '</div><div class="record-detail">' + d.count + ' 次 · ' +
      d.hours + ' 小时</div></div><div class="record-pay"><div class="amount ' +
      t.color + '">¥' + d.pay.toFixed(2) + '</div></div></div>';
  }
  document.getElementById('typeStats').innerHTML = typeHtml;
}

// 加载记录
async function loadRecords() {
  const data = await api('/api/overtime?month=' + monthStr);
  if (!data) return;
  const records = data.records;
  if (!records || records.length === 0) {
    document.getElementById('recordList').innerHTML = '<div class="empty">本月暂无加班记录</div>';
    return;
  }

  let html = '';
  for (const r of records) {
    const tagClass = r.day_type === 'holiday' ? 'tag-holiday' :
                     r.day_type === 'weekend' ? 'tag-weekend' : 'tag-workday';
    const statusTag = r.status === 'comp_off' ? ' <span class="tag tag-compoff">已调休</span>' : '';
    const compOffInfo = r.comp_off_date ? '<div class="compoff-info">调休日期：' + r.comp_off_date + '</div>' : '';

    // 操作按钮
    let actions = '<div class="record-actions">' +
      '<button class="btn-sm" onclick="openEditModal(\\''+r.id+'\\',\\''+r.off_time+'\\',\\''+(r.overtime_start||'')+'\\',\\''+(r.note||'').replace(/'/g,'\\\\\\'')+'\\')">编辑</button>' +
      '<button class="btn-sm danger" onclick="deleteRecord(\\''+r.id+'\\')">删除</button>';
    if (r.day_type === 'weekend' && r.status === 'active') {
      actions += '<button class="btn-sm" onclick="openCompoffModal(\\''+r.id+'\\',\\''+r.date+'\\',\\''+r.overtime_hours+'\\')">调休</button>';
    } else if (r.status === 'comp_off') {
      actions += '<button class="btn-sm danger" onclick="cancelCompoff(\\''+r.id+'\\')">取消调休</button>';
    }
    actions += '</div>';

    const otStartText = r.overtime_start ? ' · 加班开始 ' + r.overtime_start : '';
    html += '<div class="record"><div class="record-info"><div class="record-date">' +
      r.date + ' <span class="tag ' + tagClass + '">' + dayNames[r.day_type] +
      '</span>' + statusTag + '</div><div class="record-detail">下班 ' + r.off_time +
      otStartText + ' · ' + r.overtime_hours + 'h · ' + rateNames[r.rate] +
      (r.note ? ' · ' + r.note : '') + '</div>' + compOffInfo + actions +
      '</div><div class="record-pay"><div class="amount green">¥' +
      r.overtime_pay.toFixed(2) + '</div><div class="hours">' + r.overtime_hours + 'h</div></div></div>';
  }
  document.getElementById('recordList').innerHTML = html;
}

// ===== 编辑/删除记录 =====
let currentEditId = null;

function openEditModal(recordId, offTime, overtimeStart, note) {
  currentEditId = recordId;
  document.getElementById('editOffTime').value = offTime;
  document.getElementById('editOvertimeStart').value = overtimeStart || '';
  document.getElementById('editNote').value = note;
  document.getElementById('editModal').classList.add('show');
}

async function deleteRecord(recordId) {
  if (!confirm('确认删除这条加班记录？')) return;
  const data = await api('/api/overtime/' + recordId, { method: 'DELETE' });
  if (!data) return;
  if (data.error) { showToast(data.error); return; }
  showToast('已删除');
  loadRecords();
  loadStats();
}

document.getElementById('cancelEditBtn').onclick = () => {
  document.getElementById('editModal').classList.remove('show');
};

document.getElementById('confirmEditBtn').onclick = async () => {
  const offTime = document.getElementById('editOffTime').value;
  const overtimeStart = document.getElementById('editOvertimeStart').value;
  const note = document.getElementById('editNote').value;
  if (!offTime) { showToast('请选择下班时间'); return; }

  const data = await api('/api/overtime/' + currentEditId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ off_time: offTime, overtime_start: overtimeStart || null, note }),
  });
  if (!data) return;
  if (data.error) { showToast(data.error); return; }

  showToast('修改成功');
  document.getElementById('editModal').classList.remove('show');
  loadRecords();
  loadStats();
};

// ===== 调休操作 =====
let currentCompoffRecordId = null;

function openCompoffModal(recordId, date, hours) {
  currentCompoffRecordId = recordId;
  document.getElementById('compoffOvertimeInfo').textContent =
    '加班日期：' + date + ' · 加班 ' + hours + ' 小时 · 调休后按1倍时薪计算';
  document.getElementById('compoffDate').value = '';
  document.getElementById('compoffModal').classList.add('show');
}

async function cancelCompoff(recordId) {
  if (!confirm('确认取消调休？取消后该记录恢复为2倍加班费。')) return;
  const data = await api('/api/comp-off/' + recordId, { method: 'DELETE' });
  if (!data) return;
  if (data.error) { showToast(data.error); return; }
  showToast('已取消调休');
  loadRecords();
  loadStats();
}

document.getElementById('cancelCompoffBtn').onclick = () => {
  document.getElementById('compoffModal').classList.remove('show');
};

document.getElementById('confirmCompoffBtn').onclick = async () => {
  const compoffDate = document.getElementById('compoffDate').value;
  if (!compoffDate) { showToast('请选择调休日期'); return; }

  const data = await api('/api/comp-off', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtime_record_id: currentCompoffRecordId, comp_off_date: compoffDate }),
  });
  if (!data) return;
  if (data.error) { showToast(data.error); return; }

  showToast('调休成功，加班费已调整为1倍');
  document.getElementById('compoffModal').classList.remove('show');
  loadRecords();
  loadStats();
};

loadStats();
loadRecords();
</script></body></html>
`;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
