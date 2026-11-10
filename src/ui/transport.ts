/**
 * Play / pause / step / speed bar for the live network. The Network and Chain
 * tree tabs each show one, and both drive the same Playground, so either tab
 * can pause the run.
 */
import { esc, fmtSimTime } from './format';
import { type Playground, SPEEDS } from './playground';

let looping: Playground | null = null;

/** One requestAnimationFrame loop per playground, which stops itself when the run is paused. */
function runLoop(pg: Playground): void {
  if (looping === pg) return;
  looping = pg;
  let last = performance.now();
  const frame = (t: number) => {
    if (!pg.playing) {
      looping = null;
      return;
    }
    pg.tick((t - last) / 1000);
    last = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function mountTransport(root: HTMLElement, pg: Playground): void {
  root.innerHTML = `
    <div class="transport">
      <button class="primary" data-ref="play"></button>
      <button data-ref="step" title="Fire the next event: a block being found, or a block reaching a node">Step</button>
      <label>Speed
        <select data-ref="speed">${SPEEDS.map((s) => `<option value="${s}">${s}× ${s === 1 ? '(real time)' : ''}</option>`).join('')}</select>
      </label>
      <span class="clock">t = <strong data-ref="time"></strong></span>
    </div>
    <p class="last-event" data-ref="last"></p>`;

  const ref = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const play = ref<HTMLButtonElement>('play');
  const step = ref<HTMLButtonElement>('step');
  const speed = ref<HTMLSelectElement>('speed');
  const time = ref('time');
  const last = ref('last');

  play.addEventListener('click', () => {
    if (pg.playing) pg.pause();
    else {
      pg.play();
      runLoop(pg);
    }
  });
  step.addEventListener('click', () => {
    pg.pause();
    pg.step();
  });
  speed.addEventListener('change', () => (pg.speed = Number(speed.value)));

  let shownEvent: string | null = null;
  const render = () => {
    play.textContent = pg.playing ? '❚❚ Pause' : '▶ Play';
    const idle = pg.net.sim.pending === 0;
    step.disabled = idle;
    step.title = idle ? 'Nothing is scheduled: give a node some hash power.' : 'Fire the next event: a block being found, or a block reaching a node';
    if (speed.value !== String(pg.speed)) speed.value = String(pg.speed);
    time.textContent = fmtSimTime(pg.now);
    // This runs every frame while playing: only touch the text when it changes,
    // and only announce it to screen readers when stepping, not mid-run.
    last.setAttribute('aria-live', pg.playing ? 'off' : 'polite');
    if (pg.lastEvent !== shownEvent) {
      shownEvent = pg.lastEvent;
      last.innerHTML = shownEvent
        ? `<span class="muted">Last event:</span> ${esc(shownEvent)}`
        : '<span class="muted">Press Play, or Step through one event at a time.</span>';
    }
  };
  pg.onChange(render);
  render();
}
