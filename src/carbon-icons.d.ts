// @carbon/icons는 타입 미제공 — deep ES import(@carbon/icons/es/<name>/<size>)를 any 디스크립터로 선언.
// 디스크립터 형식: { elem:'svg', attrs:{viewBox,fill,...}, content:[{elem:'path',attrs:{d}}], name, size }
declare module '@carbon/icons/es/*' {
  // 디스크립터는 재귀 구조({elem,attrs,content:[...]})라 any로 둔다(컴포넌트 IconNode가 구조 검증).
  const icon: any;
  export default icon;
}
