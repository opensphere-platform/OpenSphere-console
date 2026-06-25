import { Component, ChangeDetectionStrategy } from '@angular/core';
import { OsShell } from './os/os-shell';

@Component({
  selector: 'app-root',
  imports: [OsShell],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: '<os-shell />',
})
export class App {}
