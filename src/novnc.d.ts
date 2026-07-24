// @novnc/novnc는 타입 선언을 배포하지 않음. package.json exports가 "./core/rfb.js"(루트만) → '@novnc/novnc'로 import.
declare module '@novnc/novnc' {
  const RFB: any;
  export default RFB;
}
