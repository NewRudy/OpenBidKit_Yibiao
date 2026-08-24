'use strict';

// 中标价格预测 POC：连接本机独立预测服务（127.0.0.1:8800），服务未启动时优雅降级。
// 服务由「市场中标价格分析及预测」项目提供（LightGBM + kNN 混合模型），接口文档见该项目 api/接口文档.md。

const PREDICTION_BASE_URL = 'http://127.0.0.1:8800';
const INFO_TIMEOUT_MS = 800;
const PREDICT_TIMEOUT_MS = 20000;

function parseJsonContent(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function createPricePredictionService({ technicalPlanStore }) {
  async function fetchWithTimeout(path, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${PREDICTION_BASE_URL}${path}`, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function buildRequestFromPlan() {
    const plan = technicalPlanStore.loadTechnicalPlan() || {};
    const projectInfo = parseJsonContent(plan.bidAnalysisTasks?.projectInfo?.content);
    const partAInfo = parseJsonContent(plan.bidAnalysisTasks?.partAInfo?.content);
    const projectName = String(projectInfo?.project_name || '').trim();
    if (!projectName) {
      return { ok: false, message: '请先完成「项目信息」解析后再预测' };
    }
    const body = { 项目名称: projectName };
    const budget = String(projectInfo?.project_budget || '').trim();
    if (budget) body.project_budget = budget;
    const address = String(projectInfo?.project_address || '').trim();
    if (address) body.project_address = address;
    const company = String(partAInfo?.company_name || '').trim();
    if (company) body.company_name = company;
    return { ok: true, body };
  }

  async function predict() {
    try {
      const infoResponse = await fetchWithTimeout('/info', {}, INFO_TIMEOUT_MS);
      if (!infoResponse.ok) throw new Error(`健康检查返回 ${infoResponse.status}`);
    } catch {
      return { success: false, unavailable: true, message: '价格预测服务未启动（127.0.0.1:8800）' };
    }

    const request = buildRequestFromPlan();
    if (!request.ok) {
      return { success: false, message: request.message };
    }

    try {
      const response = await fetchWithTimeout('/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      }, PREDICT_TIMEOUT_MS);
      if (!response.ok) {
        return { success: false, message: `预测服务返回异常（HTTP ${response.status}）` };
      }
      const data = await response.json();
      if (typeof data?.预测中标价_万元 !== 'number') {
        return { success: false, message: '预测服务返回数据格式异常' };
      }
      return { success: true, request: request.body, data };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { success: false, message: aborted ? '预测请求超时，请稍后重试' : `预测请求失败：${error?.message || '未知错误'}` };
    }
  }

  return { predict };
}

module.exports = { createPricePredictionService };
