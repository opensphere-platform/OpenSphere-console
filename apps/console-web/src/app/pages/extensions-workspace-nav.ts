import {Component,Input,Output,EventEmitter} from '@angular/core';
import {RouterLink} from '@angular/router';
@Component({
 selector:'os-extensions-workspace-nav',imports:[RouterLink],
 template:`
 <nav aria-label="Extensions 주요 작업" class="primary">
 @for(item of primary;track item.id){<a [routerLink]="'/manage/extensions/'+item.id" [class.active]="group===item.id" [attr.aria-current]="group===item.id?'page':null">{{item.label}}</a>}
 </nav>
 @if(secondary.length){<nav aria-label="현재 작업의 세부 기능" class="secondary">@for(item of secondary;track item.id){<a [routerLink]="'/manage/extensions/'+item.id" [attr.aria-current]="view===item.id?'page':null">{{item.label}}</a>}</nav>}
 <div class="heading"><div><h2>{{title}}</h2><p>{{description}}</p></div><button class="btn btn-outline" (click)="refresh.emit()">새로고침</button></div>
 @if(empty){<section class="empty"><img src="/assets/pictograms/cloud-infrastructure-management.svg" alt="" width="64" height="64"/><div><h3>다음 기능을 설치하세요</h3><p>등록된 제품 모듈이 없습니다. Cluster Manager의 배포본과 준비 조건을 확인할 수 있습니다.</p><a class="btn btn-primary" routerLink="/manage/extensions/catalog">기능 찾기</a></div></section>}
 `,
 styles:[`
 :host{display:block}.primary{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:1px solid var(--os-hairline);margin:1rem 0;}
 .primary a{padding:.65rem 1rem;color:var(--os-ink);border-bottom:3px solid transparent;text-decoration:none;font-weight:600}.primary a.active{border-color:var(--os-accent);color:var(--os-accent)}
 .secondary{display:flex;flex-wrap:wrap;gap:1rem;margin:.5rem 0}.secondary a[aria-current=page]{font-weight:600;text-decoration:underline}
 .heading{display:flex;justify-content:space-between;gap:1rem;align-items:center;margin:1rem 0}.heading h2{margin:0;font-size:var(--os-type-heading-sm,1.1rem)}.heading p{margin:.25rem 0;color:var(--os-muted)}
 .empty{display:flex;gap:1rem;align-items:center;padding:1.25rem;border:1px solid var(--os-hairline);background:var(--os-surface,#fff)}
 @media(max-width:48rem){.heading{align-items:flex-start;flex-direction:column}.primary a{padding:.5rem}.empty{align-items:flex-start}}
 `],
})
export class ExtensionsWorkspaceNav {
 @Input() view='subshells'; @Input() title=''; @Input() description=''; @Input() empty=false;
 @Output() refresh=new EventEmitter<void>();
 readonly primary=[{id:'subshells',label:'설치된 기능'},{id:'catalog',label:'기능 찾기'},{id:'audit',label:'설치·변경 작업'},{id:'topology',label:'구성·연결'},{id:'registry-connections',label:'설정·보안'}];
 get group(){return ['plugins','bindings'].includes(this.view)?'topology':this.view==='trust'?'registry-connections':this.view;}
 get secondary(){return this.group==='topology'?[{id:'topology',label:'구성도'},{id:'plugins',label:'기능 기여'},{id:'bindings',label:'외부 기능 연결'}]:this.group==='registry-connections'?[{id:'registry-connections',label:'Registry 연결'},{id:'trust',label:'신뢰·회수'}]:[];}
}
