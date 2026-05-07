require('dotenv').config();
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.join(__dirname, 'data');

// ===== データストア（JSONファイル） =====
function loadData(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

function saveData(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ===== メール送信 =====
function createTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });
}

// ===== ミドルウェア =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 },
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin/login');
}

// ===== 管理者ログイン =====
app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.authenticated = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'ユーザー名またはパスワードが正しくありません' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ===== ダッシュボード =====
app.get('/admin', requireAuth, (req, res) => {
  const campaigns = loadData('campaigns.json');
  const recipients = loadData('recipients.json');

  const stats = campaigns.map(c => {
    const r = recipients.filter(r => r.campaignId === c.id);
    return {
      ...c,
      totalCount: r.length,
      sentCount: r.filter(r => r.sentAt).length,
      clickCount: r.filter(r => r.clickedAt).length,
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.render('admin/dashboard', { campaigns: stats });
});

// ===== キャンペーン作成 =====
app.get('/admin/campaigns/new', requireAuth, (req, res) => {
  res.render('admin/campaign-new', { error: null });
});

app.post('/admin/campaigns', requireAuth, (req, res) => {
  const { name, emailSubject, emailBody, senderName, senderEmail, landingTitle } = req.body;
  const campaigns = loadData('campaigns.json');
  campaigns.push({
    id: uuidv4(),
    name, emailSubject, emailBody, senderName, senderEmail, landingTitle,
    status: 'draft',
    createdAt: new Date().toISOString(),
    sentAt: null,
  });
  saveData('campaigns.json', campaigns);
  res.redirect('/admin');
});

// ===== キャンペーン詳細・レポート =====
app.get('/admin/campaigns/:id', requireAuth, (req, res) => {
  const campaigns = loadData('campaigns.json');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).send('Not found');

  const recipients = loadData('recipients.json').filter(r => r.campaignId === campaign.id);
  const clickCount = recipients.filter(r => r.clickedAt).length;
  const sentCount = recipients.filter(r => r.sentAt).length;

  // 部署別集計
  const deptStats = {};
  recipients.forEach(r => {
    const d = r.department || '未設定';
    if (!deptStats[d]) deptStats[d] = { total: 0, clicked: 0 };
    deptStats[d].total++;
    if (r.clickedAt) deptStats[d].clicked++;
  });

  res.render('admin/campaign-detail', {
    campaign, recipients, clickCount, sentCount,
    clickRate: sentCount ? Math.round(clickCount / sentCount * 100) : 0,
    deptStats,
  });
});

// ===== 受信者CSVインポート =====
app.post('/admin/campaigns/:id/recipients', requireAuth, (req, res) => {
  const { csvText } = req.body;
  const campaigns = loadData('campaigns.json');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).send('Not found');

  const recipients = loadData('recipients.json');
  let added = 0;

  csvText.split('\n').forEach(line => {
    const cols = line.trim().split(',');
    if (cols.length < 2) return;
    const [name, email, department] = cols.map(s => s.trim());
    if (!email || !email.includes('@')) return;
    recipients.push({
      id: uuidv4(),
      campaignId: campaign.id,
      name: name || email,
      email,
      department: department || '',
      token: uuidv4(),
      sentAt: null,
      clickedAt: null,
      userAgent: null,
      ip: null,
    });
    added++;
  });

  saveData('recipients.json', recipients);
  res.redirect(`/admin/campaigns/${campaign.id}`);
});

// ===== 受信者削除 =====
app.post('/admin/campaigns/:id/recipients/:rid/delete', requireAuth, (req, res) => {
  let recipients = loadData('recipients.json');
  recipients = recipients.filter(r => r.id !== req.params.rid);
  saveData('recipients.json', recipients);
  res.redirect(`/admin/campaigns/${req.params.id}`);
});

// ===== メール送信 =====
app.post('/admin/campaigns/:id/send', requireAuth, async (req, res) => {
  const campaigns = loadData('campaigns.json');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).send('Not found');

  const recipients = loadData('recipients.json');
  const targets = recipients.filter(r => r.campaignId === campaign.id && !r.sentAt);
  if (targets.length === 0) return res.redirect(`/admin/campaigns/${campaign.id}`);

  const transporter = createTransport();
  let sentCount = 0;

  for (const r of targets) {
    const trackingUrl = `${BASE_URL}/t/${r.token}`;
    const body = campaign.emailBody.replace(/\{\{tracking_url\}\}/g, trackingUrl);
    try {
      await transporter.sendMail({
        from: `"${campaign.senderName}" <${campaign.senderEmail}>`,
        to: `"${r.name}" <${r.email}>`,
        subject: campaign.emailSubject,
        html: body,
      });
      r.sentAt = new Date().toISOString();
      sentCount++;
    } catch (e) {
      console.error(`送信失敗 ${r.email}:`, e.message);
    }
  }

  saveData('recipients.json', recipients);

  const ci = campaigns.findIndex(c => c.id === campaign.id);
  campaigns[ci].status = 'sent';
  campaigns[ci].sentAt = new Date().toISOString();
  saveData('campaigns.json', campaigns);

  console.log(`[送信完了] ${sentCount}件送信`);
  res.redirect(`/admin/campaigns/${campaign.id}`);
});

// ===== トラッキングリンク（クリック検知） =====
app.get('/t/:token', (req, res) => {
  const recipients = loadData('recipients.json');
  const ri = recipients.findIndex(r => r.token === req.params.token);
  if (ri === -1) return res.status(404).send('Not found');

  if (!recipients[ri].clickedAt) {
    recipients[ri].clickedAt = new Date().toISOString();
    recipients[ri].ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    recipients[ri].userAgent = req.headers['user-agent'];
    saveData('recipients.json', recipients);
  }

  const campaigns = loadData('campaigns.json');
  const campaign = campaigns.find(c => c.id === recipients[ri].campaignId);
  const landingTitle = campaign?.landingTitle || 'セキュリティ確認';

  res.render('landing', { landingTitle });
});

app.listen(PORT, () => {
  console.log(`標的型攻撃メール訓練システム起動: http://localhost:${PORT}/admin`);
});
