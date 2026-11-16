import { chainPlan, chainAt, chainWarnings, ChainTransport } from './chain-engine.mjs?v=chains-1';
import { decodeChainClip, releaseClip } from './chain-decode.mjs?v=chains-1';
import { frameAt } from './loop-engine.mjs?v=chains-1';

export function initChains() {
  const $ = selector => document.querySelector(selector);
  const clips = [];
  const entries = [];
  const canvas = $('#chain-video');
  const draw = canvas.getContext('2d', { alpha: false });
  const play = $('#chain-play');
  const status = $('#chain-status');
  const limit = 128 * 1024 * 1024;
  let context, gain, transport, controller, timer, animation;
  let plan = chainPlan(entries, clips);
  let nextId = 0;
  let request = 0;
  let pending = false;
  let lastTick = 0;
  const loop = () => $('#chain-loop').checked;
  const used = () => clips.reduce((sum, clip) => sum + clip.bytes, 0);
  function pause(message) {
    request++;
    pending = false;
    transport?.pause();
    clearInterval(timer);
    cancelAnimationFrame(animation);
    play.textContent = 'Play chain';
    if (message) status.textContent = message;
  }
  function paint(position = 0) {
    const current = chainAt(plan, position);
    draw.fillStyle = '#000';
    draw.fillRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = !current;
    $('#chain-empty').hidden = !!current;
    if (!current) { $('#chain-now').textContent = ''; return; }
    const clip = current.segment.clip;
    const frame = clip.frames[frameAt(clip.frames, current.position)]?.image;
    if (frame) {
      const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
      const w = frame.width * scale, h = frame.height * scale;
      draw.drawImage(frame, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }
    $('#chain-now').textContent = `Entry ${current.index + 1} of ${entries.length} · ${clip.name} · repeat ${current.repetition + 1}/${current.segment.repeats} · ${position.toFixed(1)} / ${plan.duration.toFixed(1)}s`;
    [...$('#chain-sequence').children].forEach((row, i) => {
      if (i === current.index) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
    });
  }
  function warnings() {
    const list = $('#chain-warnings');
    list.replaceChildren();
    for (const message of chainWarnings(plan, loop())) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    list.hidden = !list.children.length;
  }
  function refresh() {
    pause();
    plan = chainPlan(entries, clips);
    transport?.configure(plan, loop());
    const first = plan.segments[0]?.clip;
    if (first) { canvas.width = first.width; canvas.height = first.height; }
    play.disabled = !entries.length;
    $('#chain-restart').disabled = !entries.length;
    $('#chain-summary').textContent = entries.length ?
      `${entries.length} entries · ${entries.reduce((sum, entry) => sum + entry.repeats, 0)} clip plays · ${plan.duration.toFixed(2)}s per pass` :
      'Add clips below to build a sequence.';
    $('#chain-cache').textContent = `${clips.length}/20 clips · ${(used() / 1024 / 1024).toFixed(1)} / 128 MiB preview cache`;
    warnings();
    paint();
  }
  function button(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    return button;
  }
  function labelInput(clip, key, title) {
    const label = document.createElement('label');
    label.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = 'Optional';
    input.value = clip[key];
    input.setAttribute('aria-label', `${title} for ${clip.name}`);
    input.addEventListener('change', () => {
      clip[key] = input.value.trim();
      input.value = clip[key];
      warnings();
    });
    label.append(input);
    return label;
  }
  function renderLibrary() {
    const list = $('#chain-library');
    list.replaceChildren();
    for (const clip of clips) {
      const row = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = clip.name;
      const detail = document.createElement('small');
      detail.textContent = `${clip.duration.toFixed(2)}s · ${clip.width} × ${clip.height} preview · ${clip.audio ? 'original audio' : 'silent'}`;
      info.append(name, detail);
      const labels = document.createElement('div');
      labels.className = 'chain-labels';
      labels.append(labelInput(clip, 'startLabel', 'Start'), labelInput(clip, 'endLabel', 'End'));
      const actions = document.createElement('div');
      actions.className = 'chain-actions';
      actions.append(button('Add to sequence', `Add ${clip.name} to sequence`, () => {
        if (entries.length >= 100) { status.textContent = 'A sequence can have up to 100 entries.'; return; }
        entries.push({ clipId: clip.id, repeats: 1 });
        renderSequence(); refresh();
        status.textContent = `Added ${clip.name} as entry ${entries.length}.`;
      }), button('Remove', `Remove ${clip.name} from library`, () => {
        // Removing a library clip also removes every sequence reference.
        pause();
        for (let i = entries.length - 1; i >= 0; i--) if (entries[i].clipId === clip.id) entries.splice(i, 1);
        clips.splice(clips.indexOf(clip), 1);
        // Drop transport references before releasing decoded pictures and audio.
        renderSequence(); refresh();
        releaseClip(clip);
        renderLibrary();
        status.textContent = `Removed ${clip.name} and its sequence entries.`;
      }));
      row.append(info, labels, actions);
      list.append(row);
    }
  }
  function renderSequence() {
    const list = $('#chain-sequence');
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const clip = clips.find(clip => clip.id === entry.clipId);
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = `${index + 1}. ${clip.name}`;
      const label = document.createElement('label');
      label.textContent = 'Repeats';
      const repeats = document.createElement('input');
      repeats.type = 'number'; repeats.min = 1; repeats.max = 999; repeats.step = 1;
      repeats.value = entry.repeats;
      repeats.setAttribute('aria-label', `Repeats for entry ${index + 1}`);
      repeats.addEventListener('change', () => {
        const value = Number(repeats.value);
        if (!Number.isInteger(value) || value < 1 || value > 999) {
          repeats.value = entry.repeats;
          status.textContent = 'Repeat counts must be whole numbers from 1 to 999.';
          return;
        }
        entry.repeats = value;
        refresh();
        status.textContent = 'Repeat count updated. Playback reset to the start.';
      });
      label.append(repeats);
      const actions = document.createElement('div');
      actions.className = 'chain-actions';
      const move = delta => {
        [entries[index], entries[index + delta]] = [entries[index + delta], entries[index]];
        renderSequence(); refresh();
        $('#chain-sequence').children[index + delta].querySelector(delta < 0 ? '[data-up]' : '[data-down]').focus();
      };
      const up = button('↑', `Move entry ${index + 1} up`, () => move(-1));
      up.dataset.up = ''; up.disabled = index === 0;
      const down = button('↓', `Move entry ${index + 1} down`, () => move(1));
      down.dataset.down = ''; down.disabled = index === entries.length - 1;
      actions.append(up, down, button('Remove', `Remove entry ${index + 1}`, () => {
        entries.splice(index, 1); renderSequence(); refresh();
      }));
      row.append(name, label, actions);
      list.append(row);
    });
  }
  async function load(files) {
    if (!files.length || controller) return;
    pause();
    const current = new AbortController();
    controller = current;
    $('#chain-files').disabled = true;
    $('#chain-cancel').hidden = false;
    const failures = [];
    let added = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (current.signal.aborted) break;
        if (clips.length >= 20) { failures.push('Library limit: 20 clips.'); break; }
        // Reserve room across this batch rather than letting its first file use it all.
        const budget = Math.floor((limit - used()) / Math.min(files.length - index, 20 - clips.length));
        try {
          const clip = await decodeChainClip(file, budget, current.signal, percent => {
            status.textContent = `Decoding ${file.name}… ${percent}%`;
          });
          clip.id = ++nextId;
          clips.push(clip);
          if (entries.length < 100) entries.push({ clipId: clip.id, repeats: 1 });
          added++;
          renderLibrary(); renderSequence(); refresh();
        } catch (error) {
          if (current.signal.aborted) break;
          failures.push(`${file.name}: ${error.message}`);
        }
      }
    } finally {
      controller = null;
      $('#chain-files').disabled = false;
      $('#chain-files').value = '';
      $('#chain-cancel').hidden = true;
      status.textContent = `${current.signal.aborted ? 'Loading cancelled. ' : ''}${added} clip${added === 1 ? '' : 's'} added. ${failures.join(' ')}`;
    }
  }
  $('#chain-files').addEventListener('change', event => load([...event.target.files]));
  $('#chain-cancel').addEventListener('click', () => controller?.abort());
  $('#chain-drop').addEventListener('dragover', event => event.preventDefault());
  $('#chain-drop').addEventListener('drop', event => { event.preventDefault(); load([...event.dataTransfer.files]); });
  $('#chain-loop').addEventListener('change', () => { refresh(); status.textContent = 'Playback reset to the start.'; });
  $('#chain-restart').addEventListener('click', () => { refresh(); status.textContent = 'Ready at the start of the chain.'; });
  function render() {
    if (!transport?.running) return;
    const now = performance.now();
    if (lastTick && now - lastTick > 100) status.textContent = 'Display stalled. Replay before judging the joins.';
    lastTick = now;
    const position = transport.position(true);
    paint(position);
    if (!loop() && position >= plan.duration) { pause('Chain finished. Press Play chain to replay.'); return; }
    animation = requestAnimationFrame(render);
  }
  play.addEventListener('click', async () => {
    if (transport?.running || pending) { pause('Paused. Press Play chain to resume.'); return; }
    if (!plan.duration) return;
    const ticket = ++request;
    pending = true; play.textContent = 'Starting…';
    try {
      if (!context) {
        context = new AudioContext();
        gain = context.createGain(); gain.connect(context.destination);
        gain.gain.value = $('#chain-mute').getAttribute('aria-pressed') === 'true' ? 0 : 1;
        transport = new ChainTransport(context, gain);
        transport.configure(plan, loop());
        context.addEventListener('statechange', () => {
          if (context.state !== 'running' && transport.running) pause('Playback interrupted. Press Play chain to resume.');
        });
      }
      await context.resume();
      if (ticket !== request || document.hidden) return;
      if (context.state !== 'running') throw new Error('Audio is suspended. Press Play chain again.');
      transport.start();
      timer = setInterval(() => {
        if (transport.elapsed() > transport.next && (loop() || transport.next < plan.duration)) {
          const position = transport.position(true);
          pause('Playback scheduling stalled. Press Play chain to resume.');
          transport.offset = position;
          return;
        }
        transport.schedule();
      }, 100);
      lastTick = 0;
      play.textContent = 'Pause';
      status.textContent = 'Playing original clips with hard cuts. No automatic blends or trims.';
      render();
    } catch (error) {
      if (ticket === request) pause(error.message || 'Playback could not start.');
    } finally {
      if (ticket === request) { pending = false; if (!transport?.running) play.textContent = 'Play chain'; }
    }
  });
  $('#chain-mute').addEventListener('click', () => {
    const muted = $('#chain-mute').getAttribute('aria-pressed') !== 'true';
    $('#chain-mute').setAttribute('aria-pressed', String(muted));
    $('#chain-mute').textContent = muted ? 'Unmute' : 'Mute';
    if (gain) gain.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, .005);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause('Paused while the page is hidden.'); });
  window.addEventListener('pagehide', () => { pause(); controller?.abort(); });
  refresh();
  return { pause: () => pause(), cancelLoad: () => controller?.abort() };
}
