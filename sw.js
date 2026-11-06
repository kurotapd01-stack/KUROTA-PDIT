/**
 * Code.gs — ฝั่งเซิร์ฟเวอร์ของแอปบันทึกการผลิต (DigiShift / MINORU)  [เวอร์ชัน PWA / API]
 * รองรับ SOP, SWP, VBA, VOP — แต่ละผลิตภัณฑ์เก็บคนละไฟล์ Google Sheets
 *
 * เวอร์ชันนี้ไม่เสิร์ฟหน้าเว็บอีกต่อไป (หน้าเว็บ PWA ไปโฮสต์ที่อื่น)
 * ทำหน้าที่เป็น API: หน้าเว็บส่ง POST (JSON) มาที่ Web App URL แล้วเรียกใช้ฟังก์ชันตามชื่อ action
 *
 * ขั้นตอนตั้งค่า (ทำครั้งเดียว)
 *  1) แก้รหัสในฟังก์ชัน setApiToken() แล้วกดรันฟังก์ชันนั้น 1 ครั้ง
 *  2) Deploy > New deployment > Web app
 *       Execute as: Me   |   Who has access: Anyone
 *  3) คัดลอก Web App URL (ลงท้าย /exec) ไปใส่ API_URL ใน index.html
 *  ทุกครั้งที่แก้โค้ดไฟล์นี้ ต้อง Deploy > Manage deployments > Edit > New version
 *
 * บันทึก/แก้ไข/ลบ จะอัปเดต LossTime_Breakdown / NG_Breakdown เฉพาะแถวของ
 * record นั้น (เร็ว) ส่วน generateAllBreakdowns() ใช้ซิงค์ใหม่ทั้งหมดเมื่อจำเป็น
 *
 * นิยามการคำนวณ (ต้องตรงกับ computeLiveSummary ใน index.html):
 *   Plan       = หมวด Plan ใน Loss Time (บันทึกไว้เฉยๆ ไม่นำมาคำนวณ)
 *   Loss       = เฉพาะ 4 หมวด: MT Maintenance, PC Production Control, QC Quality Control, PD Production
 *                (LOSS_COUNT_CATS) → เก็บใน LossTime_Total
 *   Operating  = ActualTime − Loss
 *   Productivity% = ชิ้นงานดี / ((Operating*60)/CycleTime) * 100
 *   ข้อมูลเก่าที่บันทึกก่อนเปลี่ยนนิยาม: รัน recalcAllLossTimeTotals() และ recalcAllProductivity() อย่างละ 1 ครั้ง
 */

var PRODUCT_SPREADSHEETS = {
  SOP: '1CsYo5t9JQ4vMLh_ShrjsLBeb93hOmwf1Fbkg2T8iGS4',
  SWP: '1q8WR5LP7r1Vw1jjWaL-yiMDd5B0k5pTAdrUzZYKzYhQ',
  VBA: '1OW00Qc4M4XcnbiWKDS1rahaL6C5ii2im2ENLu_UNX_M',
  VOP: '1gn3Ny6CxoU6I1gpz7BVBl2Lb6EfQn3Le-whsvFVQvWY'
};

var DATA_SHEET_NAME = 'Data';
var EMPLOYEE_SHEET_NAME = 'Employees';
var CYCLETIME_SHEET_NAME = 'CycleTime_Master';

// หมวด Loss Time ที่นับเป็น Loss (ใช้คำนวณ LossTime_Total / A / P / Q / OEE / Productivity)
// ชื่อต้องตรงกับ key ใน dtData ของ index.html ทุกตัวอักษร
var LOSS_COUNT_CATS = ['MT Maintenance', 'PC Production Control', 'QC Quality Control', 'PD Production'];

// RecordID (UUID) ใช้อ้างอิงแถวตอนแก้ไข/ลบ แทนเลขแถวในชีต
var DATA_HEADERS = [
  'Timestamp', 'Date', 'Shift', 'Employees', 'Process', 'PartNumber',
  'TotalPcs', 'ActualTime', 'LossTime_JSON', 'LossTime_Total',
  'NG_JSON', 'NG_Total', 'NG_Note', 'MachineIssue',
  'CycleTime', 'GoodPieces', 'NG_Percent', 'Productivity_Percent', 'PiecePerHour',
  'RecordID', 'DayNight', 'LossTime_Note', 'LotNumber', 'LotNumber2'
];
var COL = {};
DATA_HEADERS.forEach(function (h, i) { COL[h] = i; });

// ====================================================================
// API (หน้าเว็บ PWA เรียกผ่าน POST)
// ====================================================================

// ฟังก์ชันที่อนุญาตให้เรียกจากภายนอก (ฟังก์ชันอื่นเรียกไม่ได้)
var API_ACTIONS = {
  ping: function () { return 'pong'; },
  getCycleTimeMap: getCycleTimeMap,
  getEmployees: getEmployees,
  getProcessGrandTotals: getProcessGrandTotals,
  getRecordsByProcess: getRecordsByProcess,
  saveRecord: saveRecord,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  addEmployee: addEmployee
};

function doGet() {
  return jsonOut_({ ok: true, service: 'production-log-api' });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!checkToken_(req.token)) {
      out = { ok: false, error: 'unauthorized' };
    } else if (!API_ACTIONS.hasOwnProperty(req.action)) {
      out = { ok: false, error: 'ไม่รู้จักคำสั่ง: ' + req.action };
    } else {
      out = { ok: true, result: API_ACTIONS[req.action].apply(null, Array.isArray(req.args) ? req.args : []) };
    }
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return jsonOut_(out);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  return !!expected && String(token || '') === expected;
}

/**
 * ตั้งรหัสเข้าใช้งาน (รหัสนี้พนักงานกรอกครั้งแรกที่เครื่องแท็บเล็ต)
 * แก้ค่า code ด้านล่าง แล้วรันฟังก์ชันนี้ 1 ครั้ง — ใช้รหัสยาว ๆ จำง่าย (เช่น 12 ตัวขึ้นไป)
 * เปลี่ยนรหัสภายหลังได้ด้วยการรันใหม่ (เครื่องเก่าจะถูกขอรหัสใหม่อัตโนมัติ)
 */
function setApiToken() {
  var code = 'kurota26';
  if (code === 'CHANGE-ME' || code.length < 8) {
    throw new Error('กรุณาแก้ค่า code ในฟังก์ชัน setApiToken() เป็นรหัสที่ต้องการ (อย่างน้อย 8 ตัวอักษร) ก่อนรัน');
  }
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', code);
  Logger.log('ตั้งรหัสเข้าใช้งานเรียบร้อย');
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
var ssCache_ = {};
function getSS_(product) {
  if (!PRODUCT_SPREADSHEETS.hasOwnProperty(product)) {
    throw new Error('ไม่รู้จักรหัสผลิตภัณฑ์: ' + product);
  }
  return ssCache_[product] || (ssCache_[product] = SpreadsheetApp.openById(PRODUCT_SPREADSHEETS[product]));
}

function getOrCreateSheet_(product, name, headers) {
  var ss = getSS_(product);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function forEachProduct_(fn) {
  Object.keys(PRODUCT_SPREADSHEETS).forEach(fn);
}

// ถ้าได้ล็อกไม่ทัน คืน retry:true เพื่อให้หน้าเว็บเก็บเข้าคิวแล้วลองส่งใหม่ภายหลัง
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { success: false, retry: true, error: 'ระบบกำลังบันทึกข้อมูลอื่นอยู่ ลองใหม่อีกครั้ง' };
  }
  try {
    return fn();
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function sumValues_(obj) {
  var total = 0;
  Object.keys(obj).forEach(function (key) {
    var v = obj[key];
    if (typeof v === 'number') total += v;
    else if (typeof v === 'object' && v !== null) total += sumValues_(v);
  });
  return total;
}

// Loss Total = รวมเฉพาะ 4 หมวดใน LOSS_COUNT_CATS (MT / PC / QC / PD) — ไม่รวม Plan
function lossTotal_(downtime) {
  var total = 0;
  downtime = downtime || {};
  LOSS_COUNT_CATS.forEach(function (cat) {
    var v = downtime[cat];
    if (typeof v === 'number') total += v;
    else if (typeof v === 'object' && v !== null) total += sumValues_(v);
  });
  return total;
}

function normalizeDate_(rawDate) {
  if (Object.prototype.toString.call(rawDate) === '[object Date]') {
    return Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(rawDate || '');
}

function makeCycleTimeKey_(process, partNumber) {
  return String(process || '').trim() + '||' + String(partNumber || '').trim();
}

function getCycleTimeMap(product) {
  try {
    var sheet = getSS_(product).getSheetByName(CYCLETIME_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return {};
    var map = {};
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var ct = Number(r[2]);
      if (r[0] && r[1] && !isNaN(ct)) map[makeCycleTimeKey_(r[0], r[1])] = ct;
    });
    return map;
  } catch (err) {
    return {};
  }
}

// Productivity% = ชิ้นงานดี / ((Operating*60)/CycleTime) * 100
// Operating = ActualTime − Loss(MT/PC/QC/PD) (Plan ไม่นำมาคิด)
function calcProductivity_(goodPieces, actualTime, downtime, cycleTime) {
  var operating = Math.max((Number(actualTime) || 0) - lossTotal_(downtime), 0);
  if (!(cycleTime > 0) || !(operating > 0)) return 0;
  return goodPieces / ((operating * 60) / cycleTime) * 100;
}

/**
 * สูตร: ชิ้นงานดี = รวม - NG | NG% = NG/รวม (ratio)
 * Productivity% = ดู calcProductivity_ | ชิ้น/ชม. = ชิ้นงานดี / (เวลาจริง/60)
 */
function computeMetrics_(payload, ngTotal) {
  var totalPcs = Number(payload.totalPcs) || 0;
  var actualTime = Number(payload.actualTime) || 0;
  var goodPieces = totalPcs - ngTotal;
  var cycleTime = getCycleTimeMap(payload.product)[makeCycleTimeKey_(payload.process, payload.partNumber)] || 0;

  var productivity = calcProductivity_(goodPieces, actualTime, payload.downtime || {}, cycleTime);
  var piecePerHour = actualTime > 0 ? goodPieces / (actualTime / 60) : 0;
  var ngPercent = totalPcs > 0 ? ngTotal / totalPcs : 0;

  return {
    cycleTime: cycleTime,
    goodPieces: goodPieces,
    ngPercent: Math.round(ngPercent * 10000) / 10000,
    productivityPercent: Math.round(productivity * 10) / 10,
    piecePerHour: Math.round(piecePerHour * 10) / 10
  };
}

// ------------------------------------------------------------------
// ตรวจข้อมูลฝั่งเซิร์ฟเวอร์ + กันบันทึกซ้ำ
// ------------------------------------------------------------------
function validatePayload_(payload) {
  if (!payload || !payload.product) throw new Error('ข้อมูลผลิตภัณฑ์ไม่ครบ');
  if (!PRODUCT_SPREADSHEETS.hasOwnProperty(payload.product)) throw new Error('ไม่รู้จักผลิตภัณฑ์');
  if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) throw new Error('วันที่ไม่ถูกต้อง');
  if (!payload.shift) throw new Error('กรุณาเลือกกะการทำงาน');
  if (!payload.process) throw new Error('กรุณาเลือกกระบวนการ');
  if (!payload.partNumber) throw new Error('กรุณาเลือก Part Number');

  var employees = Array.isArray(payload.employees)
    ? payload.employees.filter(function (x) { return String(x || '').trim(); }) : [];
  if (!employees.length) throw new Error('กรุณาเลือกชื่อพนักงาน');

  var totalPcs = Number(payload.totalPcs);
  var actualTime = Number(payload.actualTime);
  if (!isFinite(totalPcs) || totalPcs <= 0) throw new Error('จำนวนชิ้นงานต้องมากกว่า 0');
  if (!isFinite(actualTime) || actualTime <= 0) throw new Error('เวลาทำงานจริงต้องมากกว่า 0 นาที');

  var ngTotal = sumValues_(payload.ng || {});
  if (ngTotal < 0) throw new Error('จำนวน NG ต้องไม่ติดลบ');
  if (ngTotal > totalPcs) throw new Error('จำนวน NG ต้องไม่มากกว่าจำนวนชิ้นงานทั้งหมด');

  return { totalPcs: totalPcs, actualTime: actualTime };
}

function makeDuplicateSignature_(p) {
  var employees = (Array.isArray(p.employees) ? p.employees : [])
    .map(function (x) { return String(x || '').trim(); })
    .filter(Boolean).sort().join(',');
  return [p.product, p.date, p.shift, employees, p.process, p.partNumber,
    Number(p.totalPcs) || 0, Number(p.actualTime) || 0].map(String).join('||');
}

function findRecentDuplicate_(sheet, payload, excludeRecordId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var now = new Date().getTime();
  var data = sheet.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getValues();
  var wanted = makeDuplicateSignature_(payload);

  for (var i = data.length - 1; i >= 0; i--) {
    var r = data[i];
    var id = String(r[COL.RecordID] || '');
    if (excludeRecordId && id === String(excludeRecordId)) continue;

    var ts = r[COL.Timestamp] instanceof Date ? r[COL.Timestamp].getTime() : new Date(r[COL.Timestamp]).getTime();
    if (!isNaN(ts) && Math.abs(now - ts) > 30000) break; // ข้อมูลเรียงตามเวลา เกิน 30 วิ หยุดได้

    var existing = {
      product: payload.product,
      date: normalizeDate_(r[COL.Date]),
      shift: r[COL.Shift],
      employees: String(r[COL.Employees] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
      process: r[COL.Process],
      partNumber: r[COL.PartNumber],
      totalPcs: r[COL.TotalPcs],
      actualTime: r[COL.ActualTime]
    };
    if (makeDuplicateSignature_(existing) === wanted) return { row: i + 2, id: id };
  }
  return null;
}

function writeAuditLog_(product, action, recordId, details) {
  try {
    var sheet = getOrCreateSheet_(product, 'Audit_Log', ['Timestamp', 'Action', 'RecordID', 'User', 'Details']);
    var user = '';
    try { user = Session.getActiveUser().getEmail() || ''; } catch (e) {}
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 5).setValues([[new Date(), action, recordId || '', user, details || '']]);
  } catch (err) {
    Logger.log('⚠️ Audit_Log failed: ' + err.message);
  }
}

// คืนเลขแถวในชีตจาก RecordID (-1 ถ้าไม่พบ)
function findRowByRecordId_(sheet, recordId) {
  if (!recordId) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  // ค้นหาเฉพาะคอลัมน์ RecordID ด้วย TextFinder แทนการโหลดทั้งคอลัมน์มาไล่เช็กในหน่วยความจำ
  var cell = sheet.getRange(2, COL.RecordID + 1, lastRow - 1, 1)
    .createTextFinder(String(recordId))
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  return cell ? cell.getRow() : -1;
}

function rowToRecord_(r, sheetRow) {
  var downtime = {}, ng = {};
  try { downtime = JSON.parse(r[COL.LossTime_JSON] || '{}'); } catch (e) {}
  try { ng = JSON.parse(r[COL.NG_JSON] || '{}'); } catch (e) {}

  var employeesRaw = String(r[COL.Employees] || '');
  return {
    id: r[COL.RecordID] || ('row_' + sheetRow), // แถวเก่าที่ยังไม่มี RecordID
    date: normalizeDate_(r[COL.Date]),
    shift: r[COL.Shift],
    employees: employeesRaw
      ? employeesRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
    process: r[COL.Process],
    partNumber: r[COL.PartNumber],
    totalPcs: r[COL.TotalPcs],
    actualTime: r[COL.ActualTime],
    downtime: downtime,
    ng: ng,
    ngNote: r[COL.NG_Note],
    machineIssue: r[COL.MachineIssue],
    cycleTime: r[COL.CycleTime],
    goodPieces: r[COL.GoodPieces],
    ngPercent: r[COL.NG_Percent],
    productivityPercent: r[COL.Productivity_Percent],
    piecePerHour: r[COL.PiecePerHour],
    dayNight: r[COL.DayNight],
    downtimeNote: r[COL.LossTime_Note],
    lotNumber: r[COL.LotNumber] || '',
    lotNumber2: r[COL.LotNumber2] || ''
  };
}

function payloadToRow_(payload, timestampValue, recordId) {
  var downtimeTotal = lossTotal_(payload.downtime || {}); // เฉพาะ MT / PC / QC / PD
  var ngTotal = sumValues_(payload.ng || {});
  var m = computeMetrics_(payload, ngTotal);
  return {
    row: [
      timestampValue, payload.date || '', payload.shift || '',
      (payload.employees || []).join(', '),
      payload.process || '', payload.partNumber || '',
      Number(payload.totalPcs) || 0, Number(payload.actualTime) || 0,
      JSON.stringify(payload.downtime || {}), downtimeTotal,
      JSON.stringify(payload.ng || {}), ngTotal,
      payload.ngNote || '', payload.machineIssue || '',
      m.cycleTime, m.goodPieces, m.ngPercent, m.productivityPercent, m.piecePerHour,
      recordId, payload.dayNight || '', payload.downtimeNote || '',
      String(payload.lotNumber || '').trim(), String(payload.lotNumber2 || '').trim()
    ],
    ngTotal: ngTotal,
    downtimeTotal: downtimeTotal
  };
}

// เวลาที่กดบันทึกจริงบนเครื่อง (กรณีบันทึกออฟไลน์แล้วส่งทีหลัง) — ใช้เมื่อค่าสมเหตุสมผล ไม่งั้นใช้เวลาเซิร์ฟเวอร์
function pickTimestamp_(clientTimestamp) {
  var now = new Date();
  if (!clientTimestamp) return now;
  var t = new Date(clientTimestamp);
  var ms = t.getTime();
  if (isNaN(ms)) return now;
  if (ms > now.getTime() + 5 * 60 * 1000) return now;            // อนาคตเกิน 5 นาที
  if (ms < now.getTime() - 30 * 24 * 60 * 60 * 1000) return now;  // เก่าเกิน 30 วัน
  return t;
}

// ====================================================================
// Breakdown (แตก JSON 2 ชั้น { หมวด/เครื่อง: { รายการ: จำนวน } } เป็นคอลัมน์)
// ใช้ร่วมกันทั้ง LossTime_Breakdown และ NG_Breakdown
// ไม่ลบ-สร้างชีตใหม่ เพื่อไม่ให้ sheetId เปลี่ยน (ลิงก์/สูตรจากชีตอื่นไม่หลุด)
// ====================================================================

// สแกน JSON ของแถวที่ให้มา -> array ของหัวคอลัมน์ "หมวด | รายการ"
function scanDowntimeHeaders_(dataRows, jsonCol) {
  var seen = {}, headers = [];
  function add(key) { if (!seen[key]) { seen[key] = true; headers.push(key); } }
  dataRows.forEach(function (r) {
    var obj = {};
    try { obj = JSON.parse(r[jsonCol] || '{}'); } catch (e) {}
    Object.keys(obj).forEach(function (cat) {
      var v = obj[cat];
      if (typeof v === 'object' && v !== null) {
        Object.keys(v).forEach(function (item) { add(cat + ' | ' + item); });
      } else {
        add('(ไม่มีหมวด) | ' + cat); // ข้อมูลเก่าแบบ flat
      }
    });
  });
  return headers;
}

function flattenDowntimeRow_(dataObj, headers) {
  dataObj = dataObj || {};
  return headers.map(function (h) {
    var sep = h.indexOf(' | ');
    var cat = h.substring(0, sep), item = h.substring(sep + 3), val;
    if (cat === '(ไม่มีหมวด)') {
      val = dataObj[item];
      if (typeof val === 'object') val = 0;
    } else {
      val = (dataObj[cat] && typeof dataObj[cat] === 'object') ? dataObj[cat][item] : undefined;
    }
    return Number(val) || 0;
  });
}

// เตรียมชีต Breakdown: สร้างถ้ายังไม่มี, เติมหัวคอลัมน์ใหม่ต่อท้าย (ไม่แตะของเดิม)
function prepBreakdownSheet_(product, outName, totalColName, neededHeaders) {
  var ss = getSS_(product);
  var sheet = ss.getSheetByName(outName);
  var ref = ['RecordID', 'Date', 'Shift', 'Process', 'PartNumber', totalColName];
  if (!sheet) {
    sheet = ss.insertSheet(outName);
    sheet.getRange(1, 1, 1, ref.length).setValues([ref]);
  }
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), ref.length)).getValues()[0];
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (headers.length < ref.length) {
    sheet.getRange(1, 1, 1, ref.length).setValues([ref]);
    headers = ref.slice();
  }
  var have = {};
  headers.forEach(function (h) { have[h] = true; });
  var add = neededHeaders.filter(function (h) { return !have[h]; });
  if (add.length) {
    sheet.getRange(1, headers.length + 1, 1, add.length).setValues([add]);
    headers = headers.concat(add);
  }
  sheet.setFrozenRows(1);
  return { sheet: sheet, headers: headers, refLen: ref.length };
}

function findBreakdownRow_(sheet, recordId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || !recordId) return -1;
  var cell = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(recordId))
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  return cell ? cell.getRow() : -1;
}

// เพิ่ม/อัปเดต 1 แถว (ไม่สแกนชีต Data)
function upsertBreakdownRow_(product, outName, totalColName, recordId, date, shift, process, partNumber, total, jsonObj) {
  var needed = scanDowntimeHeaders_([[JSON.stringify(jsonObj || {})]], 0);
  var prep = prepBreakdownSheet_(product, outName, totalColName, needed);
  var row = [recordId, date, shift, process, partNumber, total]
    .concat(flattenDowntimeRow_(jsonObj || {}, prep.headers.slice(prep.refLen)));
  var rowIndex = findBreakdownRow_(prep.sheet, recordId);
  prep.sheet.getRange(rowIndex > 0 ? rowIndex : prep.sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function deleteBreakdownRow_(product, outName, recordId) {
  var sheet = getSS_(product).getSheetByName(outName);
  if (!sheet) return;
  var rowIndex = findBreakdownRow_(sheet, recordId);
  if (rowIndex > 0) sheet.deleteRow(rowIndex);
}

// payload = null -> ลบ | มี payload -> เพิ่ม/แก้ (built มาจาก payloadToRow_)
// ห่อ try/catch เพื่อไม่ให้ Breakdown พังแล้วทำให้การบันทึกหลักล้มเหลว
function refreshSingleRecordBreakdowns_(product, recordId, payload, built) {
  try {
    if (!payload) {
      deleteBreakdownRow_(product, 'LossTime_Breakdown', recordId);
      deleteBreakdownRow_(product, 'NG_Breakdown', recordId);
      return;
    }
    var d = normalizeDate_(payload.date), s = payload.shift || '', p = payload.process || '', pn = payload.partNumber || '';
    upsertBreakdownRow_(product, 'LossTime_Breakdown', 'LossTime_Total', recordId, d, s, p, pn, built.downtimeTotal, payload.downtime || {});
    upsertBreakdownRow_(product, 'NG_Breakdown', 'NG_Total', recordId, d, s, p, pn, built.ngTotal, payload.ng || {});
  } catch (err) {
    Logger.log('⚠️ รีเฟรช Breakdown ไม่สำเร็จ (' + product + '): ' + err.message);
  }
}

// ====================================================================
// ฟังก์ชันหลักที่หน้าเว็บเรียก (ผ่าน API_ACTIONS)
// ====================================================================

/**
 * บันทึกรายการใหม่
 * payload.clientId  = UUID ที่หน้าเว็บสร้างตอนเปิดฟอร์ม ใช้เป็น RecordID
 *                     ส่งซ้ำกี่ครั้งก็ได้ผลเท่าเดิม (ถ้ามี ID นี้ในชีตแล้วจะตอบ success + already:true)
 *                     จึงปลอดภัยเมื่อเน็ตหลุดกลางทางแล้วส่งใหม่จากคิวออฟไลน์
 * payload.clientTimestamp = เวลาที่กดบันทึกจริงบนเครื่อง
 */
function saveRecord(payload) {
  return withLock_(function () {
    var checked = validatePayload_(payload);
    var sheet = getOrCreateSheet_(payload.product, DATA_SHEET_NAME, DATA_HEADERS);

    var clientId = String(payload.clientId || '').trim();
    if (clientId) {
      if (!/^[0-9a-fA-F-]{32,40}$/.test(clientId)) throw new Error('clientId ไม่ถูกต้อง');
      var existingRow = findRowByRecordId_(sheet, clientId);
      if (existingRow !== -1) return { success: true, row: existingRow, id: clientId, already: true };
    } else if (findRecentDuplicate_(sheet, payload, null)) {
      return { success: false, duplicate: true, error: 'ข้อมูลชุดนี้เพิ่งถูกบันทึกไปแล้ว (อาจกดบันทึกซ้ำ)' };
    }

    var newId = clientId || Utilities.getUuid();
    var built = payloadToRow_(payload, pickTimestamp_(payload.clientTimestamp), newId);
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, built.row.length).setValues([built.row]);

    refreshSingleRecordBreakdowns_(payload.product, newId, payload, built);
    writeAuditLog_(payload.product, 'CREATE', newId, 'row=' + newRow + '; totalPcs=' + checked.totalPcs + '; actualTime=' + checked.actualTime + (clientId ? '; clientId' : ''));
    return { success: true, row: newRow, id: newId };
  });
}

function updateRecord(payload) {
  return withLock_(function () {
    var checked = validatePayload_(payload);
    if (!payload.id) return { success: false, error: 'ไม่พบ RecordID สำหรับแก้ไข' };

    var sheet = getOrCreateSheet_(payload.product, DATA_SHEET_NAME, DATA_HEADERS);
    var rowIndex = findRowByRecordId_(sheet, payload.id);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบรายการที่จะแก้ไข (อาจถูกลบหรือย้ายแถวไปแล้ว)' };

    if (findRecentDuplicate_(sheet, payload, payload.id)) {
      return { success: false, duplicate: true, error: 'มีข้อมูลชุดเดียวกันอยู่แล้ว จึงไม่บันทึกซ้ำ' };
    }

    var originalTimestamp = sheet.getRange(rowIndex, COL.Timestamp + 1).getValue();
    var built = payloadToRow_(payload, originalTimestamp, payload.id);
    sheet.getRange(rowIndex, 1, 1, built.row.length).setValues([built.row]);

    refreshSingleRecordBreakdowns_(payload.product, payload.id, payload, built);
    writeAuditLog_(payload.product, 'UPDATE', payload.id, 'row=' + rowIndex + '; totalPcs=' + checked.totalPcs + '; actualTime=' + checked.actualTime);
    return { success: true, row: rowIndex, id: payload.id };
  });
}

/**
 * ลบแบบ soft delete (clearContent) เพราะ deleteRow ทำให้สูตรในชีตอื่นที่อ้างแถวตายตัวเป็น #REF!
 * แถวว่างจะถูกอัดออกโดย compactAllProductSheets() ตอนตี 2 (ถ้าเปิด createCompactTrigger)
 */
function deleteRecord(id, product) {
  return withLock_(function () {
    var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    var rowIndex = findRowByRecordId_(sheet, id);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบรายการที่จะลบ (อาจถูกลบไปแล้ว)' };

    sheet.getRange(rowIndex, 1, 1, DATA_HEADERS.length).clearContent();
    refreshSingleRecordBreakdowns_(product, id, null, null);
    writeAuditLog_(product, 'DELETE', id, 'row=' + rowIndex + ' (soft delete / cleared, not removed)');
    return { success: true };
  });
}

function addEmployee(name, product) {
  try {
    if (!name) return { success: false, error: 'ไม่มีชื่อพนักงาน' };
    var sheet = getOrCreateSheet_(product, EMPLOYEE_SHEET_NAME, ['Name']);
    var lastRow = sheet.getLastRow();
    var existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat() : [];
    if (existing.indexOf(name) === -1) sheet.appendRow([name]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getEmployees(product) {
  try {
    var sheet = getOrCreateSheet_(product, EMPLOYEE_SHEET_NAME, ['Name']);
    if (sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .map(function (r) { return r[0]; }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ยอดรวมชิ้นงานทุกวันของแต่ละกระบวนการ เช่น { "Lathe SOP (Set 1)": 61554 }
function getProcessGrandTotals(product) {
  try {
    var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    if (sheet.getLastRow() < 2) return {};
    var totals = {};
    sheet.getRange(2, 1, sheet.getLastRow() - 1, DATA_HEADERS.length).getValues().forEach(function (r) {
      var proc = r[COL.Process];
      if (proc) totals[proc] = (totals[proc] || 0) + (Number(r[COL.TotalPcs]) || 0);
    });
    return totals;
  } catch (err) {
    return {};
  }
}

// บันทึกทั้งหมดของกระบวนการเดียว เรียงล่าสุดก่อน
function getRecordsByProcess(product, process) {
  try {
    var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    if (sheet.getLastRow() < 2) return [];
    var records = [];
    sheet.getRange(2, 1, sheet.getLastRow() - 1, DATA_HEADERS.length).getValues().forEach(function (r, i) {
      if (r[COL.Process] === process) records.push(rowToRecord_(r, i + 2));
    });
    return records.reverse();
  } catch (err) {
    return [];
  }
}

// ====================================================================
// งานดูแลระบบ (รันด้วยมือจาก Apps Script editor)
// ====================================================================

// ตั้งค่าชีตเริ่มต้นของทุกผลิตภัณฑ์ (Data / Employees / CycleTime_Master)
function initializeAllConfiguredProducts() {
  forEachProduct_(function (product) {
    getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    getOrCreateSheet_(product, EMPLOYEE_SHEET_NAME, ['Name']);
    getOrCreateSheet_(product, CYCLETIME_SHEET_NAME, ['Process', 'PartNumber', 'CycleTime']);
    Logger.log('ตั้งค่าชีตเริ่มต้น ' + product + ' เรียบร้อย');
  });
}

// แก้หัวตารางชีต Data ให้ตรง DATA_HEADERS (รันหลังเพิ่มคอลัมน์ใหม่)
function migrateAllProductHeaders() {
  forEachProduct_(function (product) {
    var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    var current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), DATA_HEADERS.length)).getValues()[0];
    var ok = DATA_HEADERS.every(function (h, i) { return current[i] === h; });
    if (!ok) {
      sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
      sheet.setFrozenRows(1);
    }
    Logger.log(product + (ok ? ' — หัวตารางตรงอยู่แล้ว' : ' — เขียนหัวตารางใหม่แล้ว'));
  });
}

// เติม RecordID ให้แถวเก่าที่ยังไม่มี (รันซ้ำได้ปลอดภัย)
function backfillAllProductRecordIds() {
  forEachProduct_(function (product) {
    var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var range = sheet.getRange(2, COL.RecordID + 1, lastRow - 1, 1);
    var updated = 0;
    var values = range.getValues().map(function (r) {
      if (r[0]) return r;
      updated++;
      return [Utilities.getUuid()];
    });
    if (updated) range.setValues(values);
    Logger.log('เติม RecordID ' + product + ': ' + updated + ' แถว');
  });
}

/**
 * คำนวณ LossTime_Total ของ "ข้อมูลเก่า" ใหม่ตามนิยามปัจจุบัน (เฉพาะ MT / PC / QC / PD) — รันด้วยมือ 1 ครั้งหลัง deploy เวอร์ชันนี้
 * อ่านจาก LossTime_JSON ของทุกแถวในชีต Data แล้วเขียนทับคอลัมน์ LossTime_Total
 * จากนั้นซิงค์ LossTime_Breakdown ให้ยอดตรงกัน (รันซ้ำได้ปลอดภัย)
 */
function recalcAllLossTimeTotals() {
  forEachProduct_(function (product) {
    var res = withLock_(function () {
      var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return { success: true, changed: 0 };
      // LossTime_JSON กับ LossTime_Total เป็นสองคอลัมน์ติดกัน
      var range = sheet.getRange(2, COL.LossTime_JSON + 1, lastRow - 1, 2);
      var changed = 0;
      var values = range.getValues().map(function (r) {
        if (r[0] === '' || r[0] === null) return r; // แถวว่าง (soft delete) หรือไม่มี Loss Time ให้คงเดิม
        var obj = {};
        try { obj = JSON.parse(r[0] || '{}'); } catch (e) { return r; }
        var t = lossTotal_(obj);
        if (Number(r[1]) !== t) changed++;
        return [r[0], t];
      });
      if (changed) range.setValues(values);
      return { success: true, changed: changed };
    });
    Logger.log('คำนวณ LossTime_Total ' + product + ': ' + (res.success ? ('แก้ ' + res.changed + ' แถว') : ('ไม่สำเร็จ — ' + res.error)));
  });
  generateAllLossTimeBreakdowns(); // ให้ LossTime_Breakdown ตรงกับ Data
}

/**
 * คำนวณ Productivity_Percent ของ "ข้อมูลเก่า" ใหม่ตามสูตรปัจจุบัน — รันด้วยมือ 1 ครั้งหลัง deploy เวอร์ชันนี้
 * ใช้ ActualTime, LossTime_JSON, GoodPieces และ CycleTime ที่เก็บไว้ในแต่ละแถว (ไม่ดึง CycleTime_Master ใหม่)
 * เขียนทับเฉพาะคอลัมน์ Productivity_Percent (รันซ้ำได้ปลอดภัย)
 */
function recalcAllProductivity() {
  forEachProduct_(function (product) {
    var res = withLock_(function () {
      var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return { success: true, changed: 0 };
      var data = sheet.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getValues();
      var changed = 0;
      var out = data.map(function (r) {
        if (!r[COL.RecordID]) return [r[COL.Productivity_Percent]]; // แถวว่าง (soft delete) คงเดิม
        var downtime = {};
        try { downtime = JSON.parse(r[COL.LossTime_JSON] || '{}'); } catch (e) {}
        var p = calcProductivity_(Number(r[COL.GoodPieces]) || 0, r[COL.ActualTime], downtime, Number(r[COL.CycleTime]) || 0);
        p = Math.round(p * 10) / 10;
        if (Number(r[COL.Productivity_Percent]) !== p) changed++;
        return [p];
      });
      if (changed) sheet.getRange(2, COL.Productivity_Percent + 1, out.length, 1).setValues(out);
      return { success: true, changed: changed };
    });
    Logger.log('คำนวณ Productivity ' + product + ': ' + (res.success ? ('แก้ ' + res.changed + ' แถว') : ('ไม่สำเร็จ — ' + res.error)));
  });
}

// อัดแถวว่าง (ที่เกิดจาก soft delete) ออกจริง — ควรรันตอนไม่มีคนใช้งาน
function compactAllProductSheets() {
  forEachProduct_(function (product) {
    withLock_(function () {
      var sheet = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;
      var ids = sheet.getRange(2, COL.RecordID + 1, lastRow - 1, 1).getValues();
      var removed = 0;
      for (var i = ids.length - 1; i >= 0; i--) {
        if (!ids[i][0]) { sheet.deleteRow(i + 2); removed++; }
      }
      Logger.log('อัดแถวว่าง ' + product + ': ลบ ' + removed + ' แถว');
    });
  });
}

// ตั้ง trigger ให้ compactAllProductSheets() รันทุกวันตอนตี 2 (รันครั้งเดียว)
function createCompactTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'compactAllProductSheets') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('compactAllProductSheets').timeBased().everyDays(1).atHour(2).create();
}

/**
 * ซิงค์ Breakdown ใหม่ทั้งชีต (สแกนทั้ง Data) — ใช้หลัง migrate/ซ่อมข้อมูล
 * จับคู่ด้วย RecordID: อัปเดตแถวเดิม, เพิ่มแถวใหม่, ลบแถวที่ไม่มีใน Data แล้ว
 */
function syncBreakdownSheet_(product, outName, jsonColName, totalColName) {
  var src = getOrCreateSheet_(product, DATA_SHEET_NAME, DATA_HEADERS);
  var lastRow = src.getLastRow();
  var data = lastRow < 2 ? [] : src.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getValues();
  var jsonCol = COL[jsonColName], totalCol = COL[totalColName];

  var prep = prepBreakdownSheet_(product, outName, totalColName, scanDowntimeHeaders_(data, jsonCol));
  var sheet = prep.sheet;
  var dynHeaders = prep.headers.slice(prep.refLen);

  var existingRowMap = {};
  var outLastRow = sheet.getLastRow();
  if (outLastRow > 1) {
    sheet.getRange(2, 1, outLastRow - 1, 1).getValues().forEach(function (r, i) {
      if (r[0]) existingRowMap[String(r[0])] = i + 2;
    });
  }

  var seenIds = {}, rowsToAppend = [];
  data.forEach(function (r) {
    var id = r[COL.RecordID];
    if (!id) return; // แถวเก่าที่ยังไม่มี RecordID — รัน backfillAllProductRecordIds ก่อน
    seenIds[String(id)] = true;

    var obj = {};
    try { obj = JSON.parse(r[jsonCol] || '{}'); } catch (e) {}
    var row = [id, normalizeDate_(r[COL.Date]), r[COL.Shift], r[COL.Process], r[COL.PartNumber], r[totalCol]]
      .concat(flattenDowntimeRow_(obj, dynHeaders));

    if (existingRowMap.hasOwnProperty(String(id))) {
      sheet.getRange(existingRowMap[String(id)], 1, 1, row.length).setValues([row]);
    } else {
      rowsToAppend.push(row);
    }
  });

  if (rowsToAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, prep.headers.length).setValues(rowsToAppend);
  }

  Object.keys(existingRowMap)
    .filter(function (id) { return !seenIds[id]; })
    .map(function (id) { return existingRowMap[id]; })
    .sort(function (a, b) { return b - a; }) // ลบจากล่างขึ้นบน
    .forEach(function (rowNum) { sheet.deleteRow(rowNum); });

  Logger.log('ซิงค์ ' + outName + ' (' + product + ') เรียบร้อย');
}

function generateAllLossTimeBreakdowns() {
  forEachProduct_(function (p) { syncBreakdownSheet_(p, 'LossTime_Breakdown', 'LossTime_JSON', 'LossTime_Total'); });
}

function generateAllNgBreakdowns() {
  forEachProduct_(function (p) { syncBreakdownSheet_(p, 'NG_Breakdown', 'NG_JSON', 'NG_Total'); });
}

// ซิงค์ทั้ง LossTime_Breakdown และ NG_Breakdown ทุกผลิตภัณฑ์ในคลิกเดียว
function generateAllBreakdowns() {
  generateAllLossTimeBreakdowns();
  generateAllNgBreakdowns();
}
