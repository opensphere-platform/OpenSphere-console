import { CommonModule } from '@angular/common';
import {
  AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges,
  OnDestroy, Output, SimpleChanges, ViewChild, signal,
} from '@angular/core';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle, bracketMatching, defaultHighlightStyle, foldGutter,
  foldKeymap, indentOnInput, syntaxHighlighting,
} from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';

/** CodeMirror 6 기반 공용 코드 에디터 — cluster-manager shared/code-editor.component.ts 이식(같은 L/F·같은 컴포넌트).
 *  - 로그/YAML 뷰: readOnly + 검색(⌘/Ctrl+F) + 줄번호 + (선택)줄바꿈
 *  - YAML 편집: 편집 + 검색 + 문법강조 + 들여쓰기 + 괄호매칭 + 히스토리
 *  CM은 root(=Document 또는 Shadow root)에 스타일을 주입하므로 셸 CSS와 격리. */
@Component({
  selector: 'app-code-editor',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="cm-shell" [class.cm-dark]="dark">
      <div class="cm-toolbar">
        <button type="button" class="os-iconbtn" title="검색 (Ctrl/⌘+F)" aria-label="검색" (click)="find()">
          <svg viewBox="0 0 24 24" class="os-ic"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>
        </button>
        <label class="os-wrap-toggle" *ngIf="showWrap">
          <input type="checkbox" [checked]="wrapOn()" (change)="setWrap($any($event.target).checked)" /> 줄바꿈
        </label>
        <span class="cm-spacer"></span>
        <ng-content></ng-content>
      </div>
      <div class="cm-host" #host [style.height]="height"></div>
    </div>
  `,
})
export class CodeEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() value = '';
  @Input() language: 'yaml' | 'log' | 'text' = 'text';
  @Input() readOnly = true;
  @Input() dark = false;
  @Input() showWrap = false;
  @Input() wrap = false;
  @Input() height = '420px';
  @Output() valueChange = new EventEmitter<string>();

  @ViewChild('host', { static: true }) hostEl!: ElementRef<HTMLElement>;

  private view?: EditorView;
  private wrapComp = new Compartment();
  readonly wrapOn = signal(false);
  private ready = false;

  ngAfterViewInit(): void {
    this.wrapOn.set(this.wrap);
    const root = this.hostEl.nativeElement.getRootNode() as ShadowRoot | Document;

    const langExt = this.language === 'yaml' ? [yaml()] : [];
    const themeExt = this.dark
      ? [oneDark]
      : [syntaxHighlighting(defaultHighlightStyle as HighlightStyle, { fallback: true })];

    const editable = !this.readOnly;

    const state = EditorState.create({
      doc: this.value || '',
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        rectangularSelection(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorState.readOnly.of(this.readOnly),
        EditorView.editable.of(editable),
        this.wrapComp.of(this.wrap ? EditorView.lineWrapping : []),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        ...(editable ? [highlightActiveLine(), highlightActiveLineGutter()] : []),
        ...langExt,
        ...themeExt,
        EditorView.theme({
          '&': { height: '100%', fontSize: '0.78rem' },
          '.cm-scroller': { fontFamily: `'SF Mono','Courier New',monospace`, lineHeight: '1.5' },
        }),
        EditorView.updateListener.of(u => {
          if (u.docChanged && editable) this.valueChange.emit(u.state.doc.toString());
        }),
      ],
    });

    this.view = new EditorView({ state, parent: this.hostEl.nativeElement, root: root as any });
    this.ready = true;
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (!this.ready || !this.view) return;
    if (ch['value'] && this.value !== this.view.state.doc.toString()) {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: this.value || '' } });
    }
    if (ch['wrap'] && !ch['wrap'].firstChange) this.setWrap(this.wrap);
  }

  find(): void { if (this.view) { this.view.focus(); openSearchPanel(this.view); } }

  setWrap(on: boolean): void {
    this.wrapOn.set(on);
    this.view?.dispatch({ effects: this.wrapComp.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  ngOnDestroy(): void { this.view?.destroy(); }
}
