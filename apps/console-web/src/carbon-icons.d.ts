// @carbon/icons는 타입 미제공 — deep ES import(@carbon/icons/es/<name>/<size>)를 any 디스크립터로 선언.
// 디스크립터 형식: { elem:'svg', attrs:{viewBox,fill,...}, content:[{elem:'path',attrs:{d}}], name, size }
declare module '@carbon/icons/es/*' {
  // 디스크립터는 재귀 구조({elem,attrs,content:[...]})라 any로 둔다(컴포넌트 IconNode가 구조 검증).
  const icon: any;
  export default icon;
}
// 집계 entry(전체 라이브러리) — IconLibraryService의 동적 import 용. 명명 export 다수(<Name><size>)라 any 모듈로 둔다.
declare module '@carbon/icons';
