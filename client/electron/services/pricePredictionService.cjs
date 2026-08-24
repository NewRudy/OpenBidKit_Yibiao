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

    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.aoa_to_sheet(buildSummaryRows(fields, result, { actualWonPriceWan, actualBidPriceWan }));
    summarySheet['!cols'] = [{ wch: 24 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, '概算汇总');

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
      XLSX.utils.book_append_sheet(workbook, similarSheet, '相似历史项目参考');
    }

    const procurement = String(procurementMarkdown || '').trim();
    if (procurement) {
      const procurementRows = [['采购清单原文（来自招标文件解析）'], [], ...procurement.split('\n').map((line) => [line])];
      const procurementSheet = XLSX.utils.aoa_to_sheet(procurementRows);
      procurementSheet['!cols'] = [{ wch: 100 }];
      XLSX.utils.book_append_sheet(workbook, procurementSheet, '采购清单原文');
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
