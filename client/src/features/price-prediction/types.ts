export interface PricePredictionRequestFields {
  项目名称: string;
  项目编号?: string;
  project_budget?: string;
  project_address?: string;
  company_name?: string;
}

export interface PricePredictionSource {
  available: boolean;
  fields: PricePredictionRequestFields;
  procurementMarkdown: string;
}

export interface PricePredictionSimilarProject {
  项目名称: string;
  业务类型?: string;
  能源类型?: string;
  中标价_万元: number;
  开标日期?: string;
  省份?: string;
  相似度?: number;
}

// 同名历史标的强锚定信息（服务端 v1.5+）
export interface PricePredictionSameNameAnchor {
  价格中位_万元?: number;
  历史成交?: string[];
  匹配?: string;
  权重?: number;
  价格一致?: boolean;
}

// 融合定价的分路信号（服务端 v1.4+「模型+双池类比」），契约仍在演进，字段宽松处理
export interface PricePredictionSignalDetail {
  联合模型_万元?: number;
  台账类比_万元?: number;
  市场类比_万元?: number;
  权重?: Record<string, number>;
  融合模式?: string;
  同名锚点?: PricePredictionSameNameAnchor | null;
  区间依据?: string;
}

export interface PricePredictionReliability {
  level?: 'high' | 'medium' | 'low' | string;
  原因?: string;
}

export interface PricePredictionKeyFactor {
  因子?: string;
  方向?: string;
  贡献log10?: number;
}

export interface PricePredictionData {
  预测中标价_万元: number;
  区间下限_万元: number;
  区间上限_万元: number;
  建议报价上限_万元: number;
  定价依据?: string;
  定价信号明细?: PricePredictionSignalDetail;
  类比可靠性?: PricePredictionReliability;
  预测逻辑链?: string[];
  关键因子?: PricePredictionKeyFactor[];
  警告?: string[] | null;
  预算锚定?: {
    预算_万元: number;
    折扣率先验?: number;
    锚定价_万元?: number;
    权重?: number;
    警告?: string;
    说明?: string;
  } | null;
  推断特征?: Record<string, string | number | null>;
  相似项目: PricePredictionSimilarProject[];
}

export interface PricePredictionResult {
  success: boolean;
  unavailable?: boolean;
  message?: string;
  request?: PricePredictionRequestFields;
  data?: PricePredictionData;
  runId?: number | null;
}

export interface PricePredictionRun {
  id: number;
  projectName: string;
  request: Partial<PricePredictionRequestFields>;
  result: PricePredictionData;
  source: string;
  createdAt: string;
  actualWonPriceWan?: number | null;
  actualBidPriceWan?: number | null;
}

export interface PricePredictionRunActualResult {
  success: boolean;
  message?: string;
  actualWonPriceWan?: number | null;
  actualBidPriceWan?: number | null;
}

export interface PricePredictionExportPayload {
  fields: PricePredictionRequestFields;
  result: PricePredictionData;
  procurementMarkdown?: string;
  actualWonPriceWan?: number | null;
  actualBidPriceWan?: number | null;
}

export interface PricePredictionExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message?: string;
}
