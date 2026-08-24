export interface PricePredictionRequestFields {
  项目名称: string;
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

export interface PricePredictionData {
  预测中标价_万元: number;
  区间下限_万元: number;
  区间上限_万元: number;
  建议报价上限_万元: number;
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
