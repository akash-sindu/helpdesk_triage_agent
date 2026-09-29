const HIGH_RISK_PATTERNS = [
  /phish(?:ing)?/i,
  /suspicious\s+(?:email|message|link)/i,
  /(?:admin|administrator|elevated|privileged)\s+access/i,
  /(?:password|account)\s+reset\s+(?:for|on\s+behalf\s+of)\s+(?:someone\s+else|another\s+person|a\s+colleague)/i,
  /(?:lost|stolen|missing)\s+(?:my\s+)?(?:laptop|device|phone|computer)/i,
  /unauthori[sz]ed\s+access/i,
  /security\s+(?:incident|breach|vulnerability)/i,
  /suspicious\s+link/i,
];

export function detectKeywordRisk(title: string, description: string): boolean {
  const text = `${title}\n${description}`;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

export function getRiskSignalLabel(keywordRisk: boolean, llmRisk: boolean): string {
  if (keywordRisk && llmRisk) return "both";
  if (keywordRisk) return "keyword";
  if (llmRisk) return "llm";
  return "neither";
}