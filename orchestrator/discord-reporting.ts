const explicitWork = /(?:^|\s)(?:\[(?:프로젝트|업무|작업|보고)\]|#(?:프로젝트|project)\b|(?:프로젝트|업무|작업|보고)\s*[:：])/i;
const explicitChat = /(?:^|\s)(?:\[(?:잡담|대화|질문)\]|(?:잡담|대화|질문)\s*[:：])/i;
const casualChat = /(자기\s*소개|반갑|안녕|뭐\s*해|저메추|점메추|가위바위보|농담|심심|잡담|(?:아침|점심|저녁|메뉴)\s*(?:뭐|추천))/i;
const workSubject = /(프로젝트|코드|기능|버그|오류|서버|시스템|자동화|노션|디스코드|앱|사이트|데이터|문서|보고서|기획|일정|예산|디자인|UI|UX|테스트|배포|리서치|조사|분석|설정|연결|파일|데이터베이스|DB|보안|권한|통합|API)/i;
const workAction = /(구현|수정|고쳐|만들|추가|삭제|점검|검토|확인|조사|분석|정리|작성|설계|계획|연결|설정|배포|테스트|검증|자동화|준비|처리|진행|완성|업데이트|바꿔|개선|리팩터|옮겨|적용|해\s*줘|해\s*봐|해라|해주세요)/i;
const explicitEnglishWork = /(?:^|\s)(?:\[(?:project|work|task|report)\]|#project\b|(?:project|work|task|report)\s*:)/i;
const explicitEnglishChat = /(?:^|\s)(?:\[(?:chat|casual|question)\]|(?:chat|casual|question)\s*:)/i;
const casualEnglishChat = /\b(?:hello|hi|introduce yourself|what are you doing|lunch recommendation|dinner recommendation|tell me a joke|small talk)\b/i;
const englishWorkSubject = /\b(?:project|code|feature|bug|error|server|system|automation|notion|discord|app|website|data|document|report|plan|schedule|budget|design|ui|ux|test|deployment|research|analysis|configuration|integration|api|checklist)\b/i;
const englishWorkAction = /\b(?:build|implement|fix|create|add|remove|inspect|review|research|analyze|organize|write|design|plan|connect|configure|deploy|test|verify|automate|prepare|process|complete|update|change|improve|refactor|move|apply|make)\b/i;

export function shouldReportDiscordWork(command: string) {
  const text = command.replace(/\s+/g, " ").trim();
  if (
    !text ||
    explicitChat.test(text) ||
    casualChat.test(text) ||
    explicitEnglishChat.test(text) ||
    casualEnglishChat.test(text)
  ) {
    return false;
  }
  if (explicitWork.test(text) || explicitEnglishWork.test(text)) return true;
  return (
    (workSubject.test(text) && workAction.test(text)) ||
    (englishWorkSubject.test(text) && englishWorkAction.test(text))
  );
}
