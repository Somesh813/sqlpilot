import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { VisualizationType } from '@sqlpilot/shared';
import { WorkspaceComponent } from './workspace.component';
import { askResponse, rowsOf } from '../testing/fixtures';

const connection = { id: 'c1', name: 'Shop', type: 'sqlite', status: 'CONNECTED', database: 'shop', writeEnabled: false };

describe('WorkspaceComponent: the ask flow as a user sees it', () => {
  let fixture: ComponentFixture<WorkspaceComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent!.replace(/\s+/g, ' ').trim();

  /** Answers the requests made on start-up (connections, schema) and returns the component ready to use. */
  function start() {
    fixture = TestBed.createComponent(WorkspaceComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/databases')).flush([connection]);
    fixture.detectChanges();
    http.match((r) => r.url.includes('/schema')).forEach((r) => r.flush({ tables: [], relationships: [], databaseName: 'shop' }));
    fixture.detectChanges();
  }
  const askFor = (q: string) => {
    fixture.componentInstance.question.set(q);
    fixture.componentInstance.ask();
    fixture.detectChanges();
  };
  const pendingAsk = (): TestRequest => http.expectOne((r) => r.url.endsWith('/ai/ask'));

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify({ ignoreCancelled: true }));

  it('LOADING: shows progress and disables asking again while the request is in flight', () => {
    start();
    askFor('How many customers are there?');
    expect(text()).toContain('How many customers are there?'); // the question appears immediately
    expect(text()).toContain('Understanding your question…'); // and so does a progress line
    const askButton = Array.from(el().querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Ask') as HTMLButtonElement;
    expect(askButton.disabled).toBe(true);
    const req = pendingAsk();
    expect(req.request.body).toEqual({ connectionId: 'c1', question: 'How many customers are there?', conversationId: undefined });

    // a second ask while thinking is ignored (no duplicate request)
    fixture.componentInstance.question.set('another');
    fixture.componentInstance.ask();
    http.expectNone((r) => r.url.endsWith('/ai/ask'));

    req.flush(askResponse({ rows: [{ total_customers: 10 }], resultType: 'single_value', numericColumns: ['total_customers'], explanation: 'There are 10 customers.' }));
    fixture.detectChanges();
    expect(text()).not.toContain('Understanding your question…'); // progress is gone
  });

  it('progress moves through its steps while waiting', fakeAsync(() => {
    start();
    askFor('Show sales by month');
    expect(text()).toContain('Understanding your question…');
    tick(1600);
    fixture.detectChanges();
    expect(text()).toContain('Generating query…');
    tick(1600);
    fixture.detectChanges();
    expect(text()).toContain('Running database query…');
    pendingAsk().flush(askResponse());
    flushMicrotasks();
    tick(100); // the scroll-to-bottom timer
    fixture.componentInstance.ngOnDestroy();
  }));

  it('TABLE: a successful answer renders the written answer and the real rows', () => {
    start();
    askFor('Show customers');
    pendingAsk().flush(askResponse({ explanation: 'Found 3 rows.', rows: rowsOf(3), numericColumns: ['spend'] }));
    fixture.detectChanges();
    expect(text()).toContain('Found 3 rows.');
    expect(el().querySelectorAll('sp-answer-card tbody tr').length).toBe(3);
  });

  it('CHART: a chart-worthy answer renders a chart', () => {
    start();
    askFor('Top customers by spending');
    pendingAsk().flush(
      askResponse({
        rows: rowsOf(5),
        numericColumns: ['spend'],
        resultType: 'categorical',
        availableViews: [VisualizationType.BAR, VisualizationType.TABLE],
        visualization: { recommended: true, type: VisualizationType.BAR, xColumn: 'name', yColumns: ['spend'] },
      }),
    );
    fixture.detectChanges();
    expect(el().querySelector('sp-chart')).not.toBeNull();
  });

  it('EMPTY: an empty result is a clear message, and the chat continues', () => {
    start();
    askFor('Customers in Atlantis');
    pendingAsk().flush(askResponse({ rows: [], columns: ['name'], resultType: 'empty', explanation: 'No matching records were found.' }));
    fixture.detectChanges();
    expect(text()).toContain('No matching records were found.');
    expect(text()).toContain('No results found for this query.');
  });

  it('TRUNCATED: the warning reaches the screen', () => {
    start();
    askFor('List everything');
    pendingAsk().flush(askResponse({ rows: rowsOf(1000), returnedRows: 1000, totalRows: 1500, truncated: true }));
    fixture.detectChanges();
    expect(text()).toContain('Showing 1,000 of 1,500 rows.');
  });

  it('ERROR (handled): a failed answer shows the friendly message', () => {
    start();
    askFor('Show sales');
    pendingAsk().flush(
      askResponse({
        success: false, sql: '', rows: [], columns: [], resultType: 'empty',
        explanation: 'The database connection is unavailable. Please check the connection and try again.',
        error: { stage: 'execution', message: 'The database connection is unavailable. Please check the connection and try again.', code: 'DB_UNAVAILABLE', technical: null },
      }),
    );
    fixture.detectChanges();
    expect(text()).toContain('The database connection is unavailable. Please check the connection and try again.');
    expect(el().querySelectorAll('sp-answer-card tbody tr').length).toBe(0);
  });

  it('ERROR (HTTP): a rate-limit response from the server is shown as its safe message and the UI recovers', () => {
    start();
    askFor('Show sales');
    pendingAsk().flush(
      { statusCode: 429, code: 'AI_BUSY', message: 'AI service is temporarily busy. Please try again in a moment.' },
      { status: 429, statusText: 'Too Many Requests' },
    );
    fixture.detectChanges();
    expect(text()).toContain('AI service is temporarily busy. Please try again in a moment.');
    const askButton = Array.from(el().querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Ask') as HTMLButtonElement;
    fixture.componentInstance.question.set('try again');
    fixture.detectChanges();
    expect(askButton.disabled).toBe(false); // the user can retry
  });

  it('ERROR (network): an unreachable API says so', () => {
    start();
    askFor('Show sales');
    pendingAsk().error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    fixture.detectChanges();
    expect(text()).toContain('Could not reach the server');
  });

  it('a follow-up carries the conversation id of the previous answer', () => {
    start();
    askFor('Show the top 5');
    pendingAsk().flush(askResponse({ conversationId: 'conv-42', rows: rowsOf(5), numericColumns: ['spend'] }));
    fixture.detectChanges();
    askFor('Only Mumbai');
    const second = pendingAsk();
    expect(second.request.body.conversationId).toBe('conv-42');
    second.flush(askResponse({ conversationId: 'conv-42', rows: rowsOf(2) }));
  });

  it('the input is cleared after asking, and blank questions are never sent', () => {
    start();
    askFor('   ');
    http.expectNone((r) => r.url.endsWith('/ai/ask'));
    askFor('Real question');
    expect(fixture.componentInstance.question()).toBe('');
    pendingAsk().flush(askResponse());
  });

  describe('the question box (DOM)', () => {
    const input = () => el().querySelector('input[placeholder^="Ask anything"]') as HTMLInputElement;
    // whenStable() never settles while the progress timer runs, so wait a beat instead
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const typeIntoBox = async (value: string) => {
      input().value = value;
      input().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await settle();
    };
    const enter = () => input().dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));

    it('is emptied on screen after a successful ask, ready for the next question', async () => {
      start();
      await typeIntoBox('First question');
      enter();
      fixture.detectChanges();
      await settle();
      pendingAsk().flush(askResponse());
      fixture.detectChanges();
      await settle();
      expect(input().value).toBe('');
      await typeIntoBox('Second question');
      expect(fixture.componentInstance.question()).toBe('Second question'); // not "First questionSecond question"
    });

    it('is emptied on screen even when Enter arrives in the same tick as the last keystroke (no change detection in between)', async () => {
      start();
      // typing and pressing Enter back to back, as fast typists, paste-and-enter and automation do
      input().focus();
      for (const ch of 'Filter those to Mumbai.') {
        input().value += ch;
        input().dispatchEvent(new Event('input', { bubbles: true }));
      }
      enter();
      fixture.detectChanges();
      await settle();
      const req = pendingAsk();
      expect(req.request.body.question).toBe('Filter those to Mumbai.');
      req.flush(askResponse());
      fixture.detectChanges();
      await settle();
      expect(fixture.componentInstance.question()).toBe('');
      expect(input().value).toBe(''); // the screen agrees with the model
      await typeIntoBox('Remove the filter.');
      expect(fixture.componentInstance.question()).toBe('Remove the filter.'); // and the next question is not glued to the old one
    });

    it('is emptied on screen after a failed ask too', async () => {
      start();
      await typeIntoBox('First question');
      enter();
      fixture.detectChanges();
      await settle();
      pendingAsk().flush({ message: 'x' }, { status: 503, statusText: 'Service Unavailable' });
      fixture.detectChanges();
      await settle();
      expect(input().value).toBe('');
    });
  });
});
