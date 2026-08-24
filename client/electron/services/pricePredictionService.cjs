'use strict';

// 中标价格预测：连接本机独立预测服务（127.0.0.1:8800），服务未启动时优雅降级。
// 预测历史持久化在 price_prediction_runs 表；预算表导出为 xlsx。
// 预测服务由「市场中标价格分析及预测」项目提供（LightGBM + kNN 混合模型），接口文档见该项目 api/接口文档.md。

const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const XLSX = require('xlsx');

const PREDICTION_BASE_URL = 'http://127.0.0.1:8800';
const INFO_TIMEOUT_MS = 800;
const PREDICT_TIMEOUT_MS = 20000;
const MAX_RUNS = 50;

function parseJsonContent(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeFilename(value) {
  return String(value || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || '价格预测';
}

function formatExportTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// 金额（元）转人民币大写，如 1030290 -> 壹佰零叁万零贰佰玖拾元整
function numberToChineseCurrency(input) {
  const amount = Math.round(Number(input) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const fraction = ['角', '分'];
  const unit = [['元', '万', '亿'], ['', '拾', '佰', '仟']];
  let n = amount;
  let s = '';
  for (let i = 0; i < fraction.length; i++) {
    s += (digit[Math.floor(n * 10 * Math.pow(10, i)) % 10] + fraction[i]).replace(/零./, '');
  }
  s = s || '整';
  n = Math.floor(n);
  for (let i = 0; i < unit[0].length && n > 0; i++) {
    let p = '';
    for (let j = 0; j < unit[1].length && n > 0; j++) {
      p = digit[n % 10] + unit[1][j] + p;
      n = Math.floor(n / 10);
    }
    s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + s;
  }
  return s.replace(/(零.)*零元/, '元').replace(/(零.)+/g, '零').replace(/^整$/, '零元整');
}

function formatYuan(value) {
  if (!Number.isFinite(value)) return '—';
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 把用户输入的预算文本（"105.96"、"105.96万元"、"1,059,600元"）换算成元
function parseAmountToYuan(raw) {
  const text = String(raw ?? '').replace(/[,，\s]/g, '');
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (/元/.test(text) && !/万/.test(text)) return num;
  return num * 10000;
}

function parseQty(text) {
  const num = Number(String(text ?? '').replace(/[,，\s]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function createPricePredictionService({ app, db, technicalPlanStore }) {
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function extractFieldsFromPlan() {
    const plan = technicalPlanStore.loadTechnicalPlan() || {};
    const projectInfo = parseJsonContent(plan.bidAnalysisTasks?.projectInfo?.content);
    const partAInfo = parseJsonContent(plan.bidAnalysisTasks?.partAInfo?.content);
    return {
      fields: {
        项目名称: String(projectInfo?.project_name || '').trim(),
        项目编号: String(projectInfo?.project_number || '').trim(),
        project_budget: String(projectInfo?.project_budget || '').trim(),
        project_address: String(projectInfo?.project_address || '').trim(),
        company_name: String(partAInfo?.company_name || '').trim(),
      },
      procurementMarkdown: String(plan.bidAnalysisTasks?.procurementList?.content || '').trim(),
    };
  }

  // 页面载入时用：把技术标解析出的项目信息带入表单（可编辑后再预测）。
  function getSourceFields() {
    const { fields, procurementMarkdown } = extractFieldsFromPlan();
    return {
      available: Boolean(fields.项目名称),
      fields,
      procurementMarkdown,
    };
  }

  function normalizeRequestFields(raw) {
    const fields = {
      项目名称: String(raw?.项目名称 || '').trim(),
      project_budget: String(raw?.project_budget || '').trim(),
      project_address: String(raw?.project_address || '').trim(),
      company_name: String(raw?.company_name || '').trim(),
    };
    const body = { 项目名称: fields.项目名称 };
    // 预算走服务文档的标准键「预算_万元」；服务端对英文键 project_budget 的兼容转译在 v1.3 出现回归，不再依赖
    if (fields.project_budget) body.预算_万元 = fields.project_budget;
    if (fields.project_address) body.project_address = fields.project_address;
    if (fields.company_name) body.company_name = fields.company_name;
    return { fields, body };
  }

  function saveRun(fields, data, source) {
    const insert = db.prepare(`
      INSERT INTO price_prediction_runs (project_name, request_json, result_json, source, created_at)
      VALUES (@project_name, @request_json, @result_json, @source, @created_at)
    `);
    const now = new Date().toISOString();
    const info = insert.run({
      project_name: fields.项目名称,
      request_json: JSON.stringify(fields),
      result_json: JSON.stringify(data),
      source,
      created_at: now,
    });
    return Number(info.lastInsertRowid);
  }

  function listRuns(limit = MAX_RUNS) {
    const rows = db.prepare(`
      SELECT id, project_name, request_json, result_json, source, created_at, actual_won_price_wan, actual_bid_price_wan
      FROM price_prediction_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || MAX_RUNS, 1), MAX_RUNS));
    return rows.map((row) => ({
      id: row.id,
      projectName: row.project_name,
      request: parseJsonContent(row.request_json) || {},
      result: parseJsonContent(row.result_json) || {},
      source: row.source,
      createdAt: row.created_at,
      actualWonPriceWan: row.actual_won_price_wan === null || row.actual_won_price_wan === undefined ? null : Number(row.actual_won_price_wan),
      actualBidPriceWan: row.actual_bid_price_wan === null || row.actual_bid_price_wan === undefined ? null : Number(row.actual_bid_price_wan),
    }));
  }

  // 项目开标后回填真实结果，作为后续训练动态折扣率模型的数据来源。
  function updateRunActual(runId, { actualWonPriceWan, actualBidPriceWan } = {}) {
    const normalize = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const num = Number(value);
      return Number.isFinite(num) && num >= 0 ? num : null;
    };
    const won = normalize(actualWonPriceWan);
    const bid = normalize(actualBidPriceWan);
    if (won === null && bid === null) {
      return { success: false, message: '请填写实际中标价或实际我方报价（万元）' };
    }
    const info = db.prepare('UPDATE price_prediction_runs SET actual_won_price_wan = ?, actual_bid_price_wan = ? WHERE id = ?').run(won, bid, Number(runId));
    if (!info.changes) {
      return { success: false, message: '预测记录不存在，请刷新历史列表后重试' };
    }
    return { success: true, actualWonPriceWan: won, actualBidPriceWan: bid };
  }

  async function predict(rawFields) {
    try {
      const infoResponse = await fetchWithTimeout(`${PREDICTION_BASE_URL}/info`, {}, INFO_TIMEOUT_MS);
      if (!infoResponse.ok) throw new Error(`健康检查返回 ${infoResponse.status}`);
    } catch {
      return { success: false, unavailable: true, message: '价格预测服务未启动（127.0.0.1:8800）' };
    }

    let normalized;
    let source;
    if (rawFields && String(rawFields.项目名称 || '').trim()) {
      normalized = normalizeRequestFields(rawFields);
      source = 'manual';
    } else {
      const planFields = extractFieldsFromPlan();
      normalized = normalizeRequestFields(planFields.fields);
      source = 'technical-plan';
    }
    if (!normalized.fields.项目名称) {
      return { success: false, message: '请填写项目名称，或先在技术方案中完成「项目信息」解析' };
    }

    try {
      const response = await fetchWithTimeout(`${PREDICTION_BASE_URL}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized.body),
      }, PREDICT_TIMEOUT_MS);
      if (!response.ok) {
        return { success: false, message: `预测服务返回异常（HTTP ${response.status}）` };
      }
      const data = await response.json();
      if (typeof data?.预测中标价_万元 !== 'number') {
        return { success: false, message: '预测服务返回数据格式异常' };
      }
      let runId = null;
      try {
        runId = saveRun(normalized.fields, data, source);
      } catch {
        // 历史记录写失败不影响预测结果展示
      }
      return { success: true, request: normalized.fields, data, runId };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { success: false, message: aborted ? '预测请求超时，请稍后重试' : `预测请求失败：${error?.message || '未知错误'}` };
    }
  }

  function buildSummaryRows(fields, data, actual = {}) {
    const rows = [
      ['中标价格预测预算表'],
      [],
      ['项目名称', fields.项目名称 || '—'],
      ['项目预算', fields.project_budget || '未提供'],
      ['项目地址', fields.project_address || '未提供'],
      ['业主单位', fields.company_name || '未提供'],
      [],
      ['预测中标价（万元）', data.预测中标价_万元],
      ['80% 置信区间下限（万元）', data.区间下限_万元],
      ['80% 置信区间上限（万元）', data.区间上限_万元],
      ['建议报价上限（万元）', data.建议报价上限_万元],
    ];
    if (actual.actualWonPriceWan !== null && actual.actualWonPriceWan !== undefined) {
      rows.push(['实际中标价（万元，开标回填）', actual.actualWonPriceWan]);
    }
    if (actual.actualBidPriceWan !== null && actual.actualBidPriceWan !== undefined) {
      rows.push(['实际我方报价（万元，开标回填）', actual.actualBidPriceWan]);
    }
    const anchor = data.预算锚定;
    if (anchor && typeof anchor.锚定价_万元 === 'number') {
      rows.push(['预算锚定（万元）', anchor.锚定价_万元]);
      rows.push(['预算锚定说明', `预算 ${anchor.预算_万元} 万元 × 折扣率 ${anchor.折扣率先验}，权重 ${anchor.权重}`]);
    } else if (anchor) {
      rows.push(['预算锚定说明', anchor.警告 || anchor.说明 || `已识别预算 ${anchor.预算_万元} 万元`]);
    }
    const features = data.推断特征
      ? Object.entries(data.推断特征).filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== '未知')
      : [];
    if (features.length) {
      rows.push(['推断特征', features.map(([key, value]) => `${key}：${value}`).join('；')]);
    }
    rows.push([]);
    rows.push(['生成时间', new Date().toLocaleString('zh-CN')]);
    rows.push(['说明', '本表由本地预测模型估算生成（相似历史项目类比 + 预算锚定），仅供报价参考；分模块/功能点单价待预测服务支持后提供。']);
    return rows;
  }

  // ---- 预算表导出：投标报价一览表 + 分项报价明细表（参考政府采购投标（报价）一览表格式）----

  // 从采购清单 markdown 表头识别各列位置；字段名不固定，按关键词模糊匹配
  function findHeaderColumns(cells) {
    const norm = cells.map((c) => String(c).replace(/\s/g, ''));
    const findIdx = (keywords, exclude) => norm.findIndex(
      (c) => keywords.some((k) => c.includes(k)) && !(exclude || []).some((k) => c.includes(k)),
    );
    const nameIdx = findIdx(['品名', '货物名称', '设备名称', '材料名称', '工作内容', '名称'], ['项目名称', '公司名称', '单位名称']);
    const specIdx = findIdx(['规格型号', '规格', '技术参数', '参数要求', '服务标准']);
    const unitIdx = findIdx(['单位'], ['单位名称']);
    const qtyIdx = findIdx(['数量']);
    const budgetIdx = findIdx(['限价', '预算金额', '预算价', '控制价']);
    if (nameIdx < 0) return null;
    // 缺数量/单位/规格的"表头"多半是「项目名称 | xxx」这类信息行，不当作清单表头
    if (qtyIdx < 0 && unitIdx < 0 && specIdx < 0) return null;
    return { nameIdx, specIdx, unitIdx, qtyIdx, budgetIdx };
  }

  const ITEM_NOISE_PATTERN = /(未找到|未提取到|未提供|^注[：:1-9]|^说明[：:]|^备注[：:])/;

  function cellsToItem(cells, header) {
    const get = (idx) => (header && Number.isInteger(idx) && idx >= 0 ? String(cells[idx] ?? '').trim() : '');
    let item;
    if (header) {
      item = {
        name: get(header.nameIdx),
        spec: get(header.specIdx),
        unit: get(header.unitIdx),
        quantity: parseQty(get(header.qtyIdx)),
        budget: header.budgetIdx >= 0 ? parseAmountToYuan(get(header.budgetIdx)) : null,
      };
    } else {
      const nameCell = cells.map((c) => String(c).trim()).find((c) => c && !/^[\d.,%\s]+$/.test(c));
      item = { name: nameCell || '', spec: '', unit: '', quantity: null, budget: null };
    }
    item.name = item.name.replace(/^[*＊]\s*/, '').trim();
    if (!item.name || ITEM_NOISE_PATTERN.test(item.name)) return null;
    // 跳过分组标题行（如「一、会议系统」且无任何数量/单位信息）
    const isGroupHeading = /^[一二三四五六七八九十]+[、.]/.test(item.name) && !item.unit && item.quantity === null;
    if (isGroupHeading) return null;
    return item;
  }

  // 把 AI 整理的采购清单 markdown 解析为明细条目；优先表格，退化为编号列表行
  function parseProcurementItems(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const items = [];
    let header = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { header = null; continue; }
      if (line.startsWith('|')) {
        const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.every((c) => !c || /^:?-{2,}:?$/.test(c))) continue; // 表头分隔行
        if (!header) {
          const found = findHeaderColumns(cells);
          if (found) { header = found; continue; }
        } else {
          const found = findHeaderColumns(cells);
          if (found && found.nameIdx !== header.nameIdx) header = found; // 文档里有多个表格时跟随新表头
        }
        const item = cellsToItem(cells, header);
        if (item) items.push(item);
      } else {
        header = null;
        const listMatch = line.match(/^(?:\d+[.、)]|[-*•]|[一二三四五六七八九十]+[、.])\s*(.+)$/);
        if (!listMatch) continue; // 普通段落不是条目
        const item = cellsToItem([listMatch[1]], null);
        if (item) items.push({ ...item, spec: '', unit: '', quantity: null, budget: null });
      }
    }
    return items;
  }

  // 把预测总价分摊到明细条目：全部条目有限价/预算时按限价占比，否则均摊；
  // 最后一条兜住四舍五入差额，保证合计恒等于预测总价。
  function allocateDetailRows(items, totalYuan) {
    const useBudget = items.length > 0 && items.every((i) => Number.isFinite(i.budget) && i.budget > 0);
    const weights = items.map((i) => (useBudget ? i.budget : 1));
    const sumWeight = weights.reduce((a, b) => a + b, 0) || 1;
    let allocated = 0;
    return items.map((item, i) => {
      const amount = i === items.length - 1
        ? Math.round((totalYuan - allocated) * 100) / 100
        : Math.round((totalYuan * weights[i]) / sumWeight * 100) / 100;
      if (i < items.length - 1) allocated += amount;
      const quantity = item.quantity || 1;
      return {
        ...item,
        quantity,
        price: Math.round((amount / quantity) * 100) / 100,
        amount,
        estimatedBy: useBudget ? '限价占比' : '均摊',
      };
    });
  }

  function buildBidSummaryRows(fields, data) {
    const totalYuan = Math.round(data.预测中标价_万元 * 10000 * 100) / 100;
    const budgetYuan = parseAmountToYuan(fields.project_budget);
    return [
      ['投标报价一览表'],
      [],
      ['项目名称', fields.项目名称 || '—'],
      ...(fields.项目编号 ? [['项目编号', fields.项目编号]] : []),
      ['招标人/采购人', fields.company_name || '按招标文件要求'],
      ['项目地点', fields.project_address || '按招标文件要求'],
      ['预算价', budgetYuan ? `${formatYuan(budgetYuan)}` : '按招标文件要求'],
      ['投标总报价（大写）', `人民币${numberToChineseCurrency(totalYuan)}`],
      ['投标总报价（小写）', formatYuan(totalYuan)],
      ['交货期/工期', '满足招标文件要求'],
      ['质保期/服务承诺', '按照招标文件标准响应'],
      [],
      ['报价说明', '本报价为闭口含税总价，已包含人工、材料、运输、利润及国家规定的各项税费。'],
      ['数据来源', `总报价由本地价格预测模型估算生成（相似历史项目类比 + 预算锚定），生成时间 ${new Date().toLocaleString('zh-CN')}；正式报价请以人工复核为准。`],
    ];
  }

  function buildBidDetailRows(detailItems, data) {
    const totalYuan = Math.round(data.预测中标价_万元 * 10000 * 100) / 100;
    const rows = [
      ['分项报价明细表'],
      [],
      ['序号', '品名/工作内容', '规格型号/服务标准', '单位', '数量', '单价（元）', '合价（元）'],
    ];
    detailItems.forEach((item, i) => {
      rows.push([
        i + 1,
        item.name,
        item.spec || '满足招标文件技术要求',
        item.unit || '项',
        item.quantity,
        item.price.toFixed(3),
        item.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      ]);
    });
    rows.push(['总计', '—', '—', '—', '—', '—', formatYuan(totalYuan)]);
    rows.push([]);
    rows.push(['说明', `分项单价由预测总报价按${detailItems[0]?.estimatedBy === '限价占比' ? '清单限价占比' : '均摊'}估算生成（预测服务暂不支持逐项定价），仅供参考，正式报价前请人工调整。`]);
    rows.push(['盖章', '（电子公章）']);
    rows.push(['制表日期', new Date().toLocaleDateString('zh-CN')]);
    return rows;
  }

  async function exportBudgetTable({ fields, result, procurementMarkdown, actualWonPriceWan, actualBidPriceWan } = {}) {
    if (!result?.预测中标价_万元 || !fields?.项目名称) {
      return { success: false, message: '缺少预测结果，无法导出预算表' };
    }
    const defaultDir = app?.getPath ? app.getPath('downloads') : process.cwd();
    const saveResult = await dialog.showSaveDialog({
      title: '导出价格预测预算表',
      defaultPath: path.join(defaultDir, `${sanitizeFilename(fields.项目名称)}_预算表_${formatExportTimestamp()}.xlsx`),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }

    // 前端 payload 不含项目编号，现场从技术方案解析结果补充（用户在表单里改过的字段以前端为准）
    const planFields = extractFieldsFromPlan();
    const exportFields = {
      ...planFields.fields,
      ...Object.fromEntries(Object.entries(fields || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')),
      项目名称: fields.项目名称,
    };

    const totalYuan = Math.round(result.预测中标价_万元 * 10000 * 100) / 100;
    const workbook = XLSX.utils.book_new();

    // Sheet1：投标报价一览表（总价 + 大小写，对外格式）
    const summarySheet = XLSX.utils.aoa_to_sheet(buildBidSummaryRows(exportFields, result));
    summarySheet['!cols'] = [{ wch: 22 }, { wch: 66 }];
    summarySheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, '投标报价一览表');

    // Sheet2：分项报价明细表（条目来自采购清单解析，金额由预测总分摊估算）
    const detailItems = allocateDetailRows(parseProcurementItems(procurementMarkdown), totalYuan);
    const noteRowStart = 3 + detailItems.length + 2; // 标题+空行+表头+条目+总计 之后的第一行
    const detailSheet = XLSX.utils.aoa_to_sheet(buildBidDetailRows(detailItems, result));
    detailSheet['!cols'] = [{ wch: 6 }, { wch: 34 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 16 }];
    detailSheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      ...[noteRowStart, noteRowStart + 1, noteRowStart + 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: 5 } })),
    ];
    XLSX.utils.book_append_sheet(workbook, detailSheet, '分项报价明细表');

    // Sheet3：内部参考附页（预测明细依据），正式递交时可删除
    const basisSheet = XLSX.utils.aoa_to_sheet(buildSummaryRows(exportFields, result, { actualWonPriceWan, actualBidPriceWan }));
    basisSheet['!cols'] = [{ wch: 24 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(workbook, basisSheet, '附-预测汇总');

    const similarProjects = Array.isArray(result.相似项目) ? result.相似项目.slice(0, 5) : [];
    if (similarProjects.length) {
      const similarRows = [
        ['项目名称', '中标价（万元）', '开标日期', '业务类型', '能源类型', '相似度'],
        ...similarProjects.map((project) => [
          project.项目名称 || '—',
          typeof project.中标价_万元 === 'number' ? project.中标价_万元 : '—',
          project.开标日期 || '—',
          project.业务类型 || '—',
          project.能源类型 || '—',
          typeof project.相似度 === 'number' ? project.相似度 : '—',
        ]),
      ];
      const similarSheet = XLSX.utils.aoa_to_sheet(similarRows);
      similarSheet['!cols'] = [{ wch: 48 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(workbook, similarSheet, '附-相似历史项目');
    }

    const procurement = String(procurementMarkdown || '').trim();
    if (procurement) {
      const procurementRows = [['采购清单原文（来自招标文件解析）'], [], ...procurement.split('\n').map((line) => [line])];
      const procurementSheet = XLSX.utils.aoa_to_sheet(procurementRows);
      procurementSheet['!cols'] = [{ wch: 100 }];
      XLSX.utils.book_append_sheet(workbook, procurementSheet, '附-采购清单原文');
    }

    try {
      XLSX.writeFile(workbook, saveResult.filePath);
      return { success: true, path: saveResult.filePath, message: '预算表已导出' };
    } catch (error) {
      return { success: false, message: `导出预算表失败：${error?.message || '未知错误'}` };
    }
  }

  return { getSourceFields, predict, listRuns, updateRunActual, exportBudgetTable };
}

module.exports = { createPricePredictionService };
