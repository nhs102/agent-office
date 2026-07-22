export type OfficeLanguage = "ko" | "en";

export function detectOfficeLanguage(text: unknown): OfficeLanguage {
  if (typeof text !== "string") return "ko";
  const hangulCount = (text.match(/[가-힣]/g) ?? []).length;
  const latinWordCount = (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? []).length;
  if (hangulCount >= 2) return "ko";
  return latinWordCount >= 2 ? "en" : "ko";
}

export function officeLanguageInstruction(language: OfficeLanguage) {
  return language === "en"
    ? "[RESPONSE LANGUAGE: ENGLISH]\nWrite every user-visible progress update, handoff, summary, and final answer in natural English only. Do not use Korean honorifics or mix in Korean. Preserve this language requirement in every internal handoff."
    : "[응답 언어: 한국어]\n사용자에게 보이는 진행 보고, 전달, 요약과 최종 답변은 자연스러운 한국어로 작성하세요. 내부 전달에도 이 언어 조건을 유지하세요.";
}

export function officeLanguageText(
  language: OfficeLanguage,
  korean: string,
  english: string,
) {
  return language === "en" ? english : korean;
}
