import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { PricePredictionData, PricePredictionRequestFields, PricePredictionResult, PricePredictionRun, PricePredictionSource } from '../types';

const EMPTY_FIELDS: PricePredictionRequestFields = {
  项目名称: '',
  project_budget: '',
  project_address: '',
  company_name: '',
};

function formatWanValue(value: number): string {
  const wan = value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return value >= 10000
    ? `${wan} 万元（约 ${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 亿元）`
    : `${wan} 万元`;
}

function formatRunTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

export default function PricePredictionPage() {
  const { showToast } = useToast();
  const [fields, setFields] = useState<PricePredictionRequestFields>(EMPTY_FIELDS);
  const [source, setSource] = useState<PricePredictionSource | null>(null);
  const [procurementMarkdown, setProcurementMarkdown] = useState('');
  const [predicting, setPredicting] = useState(false);
  const [prediction, setPrediction] = useState<PricePredictionResult | null>(null);
  const [runs, setRuns] = useState<PricePredictionRun[]>([]);
  const [exporting, setExporting] = useState(false);
  const [actualWon, setActualWon] = useState('');
  const [actualBid, setActualBid] = useState('');
  const [actualSaved, setActualSaved] = useState(false);
  const [savingActual, setSavingActual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sourceResult, runsResult] = await Promise.all([
          window.yibiao?.pricePrediction.getSourceFields(),
          window.yibiao?.pricePrediction.listRuns(),
        ]);
        if (cancelled) return;
        if (sourceResult?.available) {
          setSource(sourceResult);
          setProcurementMarkdown(sourceResult.procurementMarkdown || '');
          setFields({ ...EMPTY_FIELDS, ...sourceResult.fields });
        }
        setRuns(runsResult || []);
      } catch {
        // 页面仍可手动填写，不提示错误
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = (key: keyof PricePredictionRequestFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const reloadFromParse = async () => {
    try {
      const sourceResult = await window.yibiao?.pricePrediction.getSourceFields();
      if (!sourceResult?.available) {
        showToast('技术方案尚未完成「项目信息」解析，可手动填写后预测', 'info');
        return;
      }
      setSource(sourceResult);
      setProcurementMarkdown(sourceResult.procurementMarkdown || '');
      setFields({ ...EMPTY_FIELDS, ...sourceResult.fields });
      showToast('已带入技术方案解析结果', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '带入解析结果失败', 'error');
    }
  };

  const refreshRuns = async () => {
    try {
      setRuns((await window.yibiao?.pricePrediction.listRuns()) || []);
    } catch {
      // 历史加载失败不打断预测展示
    }
  };

  const runPrediction = async () => {
    if (predicting) return;
    if (!fields.项目名称.trim()) {
      showToast('请填写项目名称', 'info');
      return;
    }
    try {
      setPredicting(true);
      const result = await window.yibiao?.pricePrediction.predict({ ...fields, 项目名称: fields.项目名称.trim() });
      setPrediction(result || { success: false, message: '预测请求失败' });
      if (result?.success) {
        showToast('价格预测完成', 'success');
        setActualWon('');
        setActualBid('');
        setActualSaved(false);
        void refreshRuns();
      }
    } catch (error) {
      setPrediction({ success: false, message: error instanceof Error ? error.message : '预测请求失败' });
    } finally {
      setPredicting(false);
    }
  };

  const loadRun = (run: PricePredictionRun) => {
    setFields({ ...EMPTY_FIELDS, ...run.request, 项目名称: run.projectName || run.request.项目名称 || '' });
    setPrediction({ success: true, request: { ...EMPTY_FIELDS, ...run.request }, data: run.result, runId: run.id });
    setActualWon(run.actualWonPriceWan !== null && run.actualWonPriceWan !== undefined ? String(run.actualWonPriceWan) : '');
    setActualBid(run.actualBidPriceWan !== null && run.actualBidPriceWan !== undefined ? String(run.actualBidPriceWan) : '');
    setActualSaved(run.actualWonPriceWan !== null && run.actualWonPriceWan !== undefined || run.actualBidPriceWan !== null && run.actualBidPriceWan !== undefined);
  };

  const saveActual = async () => {
    const runId = prediction?.runId;
    if (!runId || savingActual) return;
    if (!actualWon.trim() && !actualBid.trim()) {
      showToast('请填写实际中标价或实际我方报价（万元）', 'info');
      return;
    }
    try {
      setSavingActual(true);
      const result = await window.yibiao?.pricePrediction.updateRunActual(runId, { actualWonPriceWan: actualWon.trim(), actualBidPriceWan: actualBid.trim() });
      if (result?.success) {
        setActualSaved(true);
        showToast('已回填实际结果', 'success');
        void refreshRuns();
      } else {
        showToast(result?.message || '回填失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '回填失败', 'error');
    } finally {
      setSavingActual(false);
    }
  };

  const exportBudget = async () => {
    if (exporting || !prediction?.success || !prediction.data) return;
    try {
      setExporting(true);
      const result = await window.yibiao?.pricePrediction.exportBudgetTable({
        fields,
        result: prediction.data,
        procurementMarkdown,
        actualWonPriceWan: actualWon.trim() ? Number(actualWon) : null,
        actualBidPriceWan: actualBid.trim() ? Number(actualBid) : null,
      });
      if (result?.success) {
        showToast(`预算表已导出：${result.path}`, 'success');
      } else if (!result?.canceled) {
        showToast(result?.message || '导出预算表失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出预算表失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  const data: PricePredictionData | null = prediction?.success ? prediction.data || null : null;
  const anchor = data?.预算锚定 || null;
  const features = data?.推断特征
    ? Object.entries(data.推断特征).filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== '未知')
    : [];
  const similarProjects = data?.相似项目?.slice(0, 5) || [];

  return (
    <div className="plan-step-body price-prediction-page">
      <section className="price-prediction-command-bar">
        <div>
          <span className="section-kicker">辅助决策</span>
          <strong>中标价格预测</strong>
          <p>基于院内 2023-2026 年历史中标数据的本地模型估算（相似项目类比 + 预算锚定），预测结果不超招标预算、不显著低于预算，供报价决策参考。</p>
        </div>
      </section>

      <section className="price-prediction-workspace">
        <div className="price-prediction-main">
          <section className="price-prediction-panel" aria-label="项目信息">
            <header className="price-prediction-panel-head">
              <div>
                <span className="section-kicker">STEP 01</span>
                <strong>项目信息</strong>
              </div>
              <button type="button" className="secondary-action" onClick={() => { void reloadFromParse(); }}>
                带入技术方案解析结果
              </button>
            </header>
            <div className="price-prediction-form">
              <label>
                <span>项目名称（必填）</span>
                <input
                  value={fields.项目名称}
                  onChange={(event) => updateField('项目名称', event.target.value)}
                  placeholder="如：某抽水蓄能电站勘察设计"
                />
              </label>
              <label>
                <span>项目预算（可选）</span>
                <input
                  value={fields.project_budget || ''}
                  onChange={(event) => updateField('project_budget', event.target.value)}
                  placeholder="支持“1.4亿元”“5000万”等写法，越准预测越准"
                />
              </label>
              <label>
                <span>项目地址（可选）</span>
                <input
                  value={fields.project_address || ''}
                  onChange={(event) => updateField('project_address', event.target.value)}
                  placeholder="如：贵州省贵阳市"
                />
              </label>
              <label>
                <span>业主单位（可选）</span>
                <input
                  value={fields.company_name || ''}
                  onChange={(event) => updateField('company_name', event.target.value)}
                  placeholder="如：某水电开发有限公司"
                />
              </label>
            </div>
            {source?.available && (
              <p className="price-prediction-hint">已带入当前技术方案的解析结果{procurementMarkdown ? '，导出预算表将附采购清单原文' : ''}；可直接修改后再预测。</p>
            )}
          </section>

          <section className="price-prediction-panel" aria-label="预测结果">
            <header className="price-prediction-panel-head">
              <div>
                <span className="section-kicker">STEP 02</span>
                <strong>预测结果</strong>
              </div>
              <div className="price-prediction-panel-actions">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => { void exportBudget(); }}
                  disabled={exporting || !data}
                >
                  {exporting ? '导出中...' : '导出预算表'}
                </button>
                <button type="button" className="primary-action" onClick={() => { void runPrediction(); }} disabled={predicting}>
                  {predicting ? '预测中...' : data ? '重新预测' : '立即预测'}
                </button>
              </div>
            </header>

            {prediction && !prediction.success && (
              <div className="price-prediction-empty">
                <strong>{prediction.unavailable ? '预测服务未启动' : '暂无法预测'}</strong>
                <p>{prediction.message}</p>
              </div>
            )}

            {!prediction && (
              <div className="price-prediction-empty">
                <strong>尚未预测</strong>
                <p>填写项目信息后点击「立即预测」；预算信息越完整，预测精度越高。</p>
              </div>
            )}

            {data && (
              <div className="price-prediction-result">
                <div className="price-prediction-metrics">
                  <div className="price-prediction-metric is-primary">
                    <span>预测中标价</span>
                    <strong>{formatWanValue(data.预测中标价_万元)}</strong>
                  </div>
                  <div className="price-prediction-metric">
                    <span>80% 置信区间</span>
                    <strong>{`${data.区间下限_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ~ ${data.区间上限_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元`}</strong>
                    {data.定价信号明细?.区间依据 && <small title={data.定价信号明细.区间依据}>{`依据：${data.定价信号明细.区间依据}`}</small>}
                  </div>
                  <div className="price-prediction-metric">
                    <span>建议报价上限</span>
                    <strong>{formatWanValue(data.建议报价上限_万元)}</strong>
                  </div>
                </div>

                {Array.isArray(data.警告) && data.警告.length > 0 && (
                  <div className="price-prediction-alert is-warning">
                    {data.警告.map((item, index) => <p key={index}>{`⚠️ ${item}`}</p>)}
                  </div>
                )}

                {(() => {
                  const reliability = data.类比可靠性;
                  if (!reliability?.level || reliability.level === 'high') return null;
                  return (
                    <div className={`price-prediction-alert is-${reliability.level}`}>
                      <p>
                        {reliability.level === 'low' ? '⛔ 类比可靠性低：' : '⚠️ 类比可靠性中等：'}
                        {reliability.原因 || '历史样本对本案支撑有限，请谨慎使用点估计。'}
                      </p>
                    </div>
                  );
                })()}

                {(() => {
                  const anchorInfo = data.定价信号明细?.同名锚点;
                  if (!anchorInfo) return null;
                  return (
                    <div className="price-prediction-same-anchor">
                      <div className="price-prediction-same-anchor-head">
                        <strong>{anchorInfo.匹配 === '精确同名' ? '命中同名历史标的，直采其成交价' : '命中近似同名历史标的，强锚定'}</strong>
                        <em>{typeof anchorInfo.价格中位_万元 === 'number' ? `${anchorInfo.价格中位_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元` : ''}</em>
                      </div>
                      {Array.isArray(anchorInfo.历史成交) && anchorInfo.历史成交.length > 0 && (
                        <ul>
                          {anchorInfo.历史成交.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      )}
                    </div>
                  );
                })()}
                {anchor && (
                  <p className="price-prediction-anchor">
                    {typeof anchor.锚定价_万元 === 'number'
                      ? `已按预算 ${anchor.预算_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元 × 折扣率 ${anchor.折扣率先验} 锚定（权重 ${anchor.权重}）`
                      : `已识别预算 ${anchor.预算_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元`}
                    {anchor.说明 ? `；${anchor.说明}` : ''}
                    {anchor.警告 ? `；${anchor.警告}` : ''}
                  </p>
                )}

                {!prediction?.request?.project_budget && (
                  <p className="price-prediction-anchor">
                    未提供项目预算，本次预测未启用预算锚定，精度受限；预算是最强的参考信号，建议补填后重新预测。
                  </p>
                )}

                {data.定价依据 && (
                  <div className="price-prediction-signals">
                    <div className="price-prediction-signals-head">
                      <strong>定价信号</strong>
                      <em>{[data.定价依据, data.定价信号明细?.融合模式].filter(Boolean).join(' · ')}</em>
                    </div>
                    {(() => {
                      const signals = data.定价信号明细;
                      if (!signals) return null;
                      const rows: Array<{ name: string; value: number }> = [];
                      if (typeof signals.联合模型_万元 === 'number') rows.push({ name: '联合模型', value: signals.联合模型_万元 });
                      if (typeof signals.台账类比_万元 === 'number') rows.push({ name: '台账类比', value: signals.台账类比_万元 });
                      if (typeof signals.市场类比_万元 === 'number') rows.push({ name: '市场类比', value: signals.市场类比_万元 });
                      const weights = signals.权重 || {};
                      const weightOf = (name: string) => {
                        const match = Object.entries(weights).find(([key]) => key.startsWith(name));
                        return match && typeof match[1] === 'number' ? match[1] : null;
                      };
                      if (!rows.length) return null;
                      return (
                        <ul>
                          {rows.map((row) => {
                            const weight = weightOf(row.name);
                            return (
                              <li key={row.name}>
                                <span className="price-prediction-signal-name">{row.name}</span>
                                <span className="price-prediction-signal-value">{`${row.value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元`}</span>
                                {weight !== null && (
                                  <span className="price-prediction-signal-weight" title={`权重 ${(weight * 100).toFixed(0)}%`}>
                                    <i style={{ width: `${Math.round(Math.min(Math.max(weight, 0), 1) * 100)}%` }} />
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      );
                    })()}
                  </div>
                )}

                {Array.isArray(data.预测逻辑链) && data.预测逻辑链.length > 0 && (
                  <div className="price-prediction-logic-chain">
                    <strong>预测逻辑链</strong>
                    <ol>
                      {data.预测逻辑链.map((step, index) => <li key={index}>{step}</li>)}
                    </ol>
                  </div>
                )}

                {Array.isArray(data.关键因子) && data.关键因子.length > 0 && (
                  <div className="price-prediction-factors">
                    <strong>关键因子</strong>
                    <div className="price-prediction-features">
                      {data.关键因子.map((factor, index) => (
                        <span
                          key={index}
                          title={typeof factor.贡献log10 === 'number' ? `影响数量级约 10^${factor.贡献log10.toFixed(1)}` : undefined}
                        >
                          {`${factor.因子 || '未知因子'} ${String(factor.方向 || '')}`}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {features.length > 0 && (
                  <div className="price-prediction-features">
                    {features.map(([key, value]) => (
                      <span key={key}>{`${key}：${String(value)}`}</span>
                    ))}
                  </div>
                )}

                {similarProjects.length > 0 && (
                  <div className="price-prediction-similar">
                    <strong>最相似的历史项目（预测依据）</strong>
                    {(() => {
                      const prices = similarProjects
                        .map((project) => project.中标价_万元)
                        .filter((value) => typeof value === 'number' && value > 0);
                      const spread = prices.length >= 2 ? Math.max(...prices) / Math.min(...prices) : null;
                      if (spread === null || spread < 5) return null;
                      return (
                        <p className="price-prediction-similar-warning">
                          {`⚠️ 相似项目最高价约为最低价的 ${spread.toFixed(1)} 倍，历史样本离散度过高，类比结果可靠性有限；若列表中存在同名/同类项目，建议以其为主要参考。`}
                        </p>
                      );
                    })()}
                    <ul>
                      {similarProjects.map((project) => (
                        <li key={`${project.项目名称}-${project.开标日期 || ''}`}>
                          <span className="price-prediction-similar-name" title={project.项目名称}>{project.项目名称}</span>
                          <span>{project.中标价_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元</span>
                          <span>{project.开标日期 || '—'}</span>
                          {typeof project.相似度 === 'number' && <span>{`相似度 ${project.相似度 <= 1 ? `${(project.相似度 * 100).toFixed(0)}%` : project.相似度.toFixed(2)}`}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {prediction?.runId && (
                  <div className="price-prediction-actual">
                    <div className="price-prediction-actual-head">
                      <strong>开标结果回填</strong>
                      {actualSaved && <em>已回填</em>}
                    </div>
                    <div className="price-prediction-actual-form">
                      <label>
                        <span>实际中标价（万元）</span>
                        <input inputMode="decimal" value={actualWon} onChange={(event) => setActualWon(event.target.value)} placeholder="开标后回填，用于提升预测精度" />
                      </label>
                      <label>
                        <span>实际我方报价（万元，可选）</span>
                        <input inputMode="decimal" value={actualBid} onChange={(event) => setActualBid(event.target.value)} placeholder="选填" />
                      </label>
                      <button type="button" className="secondary-action" onClick={() => { void saveActual(); }} disabled={savingActual}>
                        {savingActual ? '保存中...' : '保存回填'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <aside className="price-prediction-history" aria-label="预测历史">
          <div className="price-prediction-panel-head">
            <strong>预测历史</strong>
            <span>{runs.length} 条</span>
          </div>
          {runs.length === 0 ? (
            <p className="price-prediction-history-empty">暂无预测记录，完成首次预测后自动保存。</p>
          ) : (
            <div className="price-prediction-history-list">
              {runs.map((run) => (
                <button type="button" className={`price-prediction-history-item${run.actualWonPriceWan !== null && run.actualWonPriceWan !== undefined ? ' is-backfilled' : ''}`} key={run.id} onClick={() => loadRun(run)}>
                  <strong title={run.projectName}>{run.projectName}</strong>
                  <small>
                    {`${run.result.预测中标价_万元.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万元 · ${formatRunTime(run.createdAt)}`}
                    {run.actualWonPriceWan !== null && run.actualWonPriceWan !== undefined ? ' · 已回填' : ''}
                  </small>
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
