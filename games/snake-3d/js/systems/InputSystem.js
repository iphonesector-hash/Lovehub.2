/**
 * InputSystem — keyboard + touch joystick + swipe
 * Mobile-first, prevents browser gestures.
 */

export class InputSystem {
  constructor(container) {
    this.container = container || document.body;
    this.direction = { x: 0, z: -1 };
    this.targetDirection = { x: 0, z: -1 };
    this.boost = false;
    this.enabled = true;

    this.joystick = {
      active: false,
      originX: 0,
      originY: 0,
      dx: 0,
      dy: 0,
      maxRadius: 50,
    };

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this.container.addEventListener('touchstart', this._prevent, { passive: false });
    this.container.addEventListener('touchmove', this._prevent, { passive: false });

    this.base = document.getElementById('joystick-base');
    this.knob = document.getElementById('joystick-knob');
    this.zone = document.getElementById('joystick-zone');

    if (this.base) {
      this.base.addEventListener('touchstart', this._onJoyStart, { passive: false });
      this.base.addEventListener('touchmove', this._onJoyMove, { passive: false });
      this.base.addEventListener('touchend', this._onJoyEnd, { passive: false });
      this.base.addEventListener('touchcancel', this._onJoyEnd, { passive: false });
    }

    const canvas = document.getElementById('canvas-container');
    if (canvas) {
      canvas.addEventListener('touchstart', this._onSwipeStart, { passive: false });
      canvas.addEventListener('touchmove', this._onSwipeMove, { passive: false });
      canvas.addEventListener('touchend', this._onSwipeEnd, { passive: false });
    }
  }

  _prevent = (e) => {
    if (e.target.closest('.joystick-zone') || e.target.closest('#canvas-container')) {
      e.preventDefault();
    }
  };

  _onKeyDown = (e) => {
    if (!this.enabled) return;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.targetDirection = { x: 0, z: -1 };
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.targetDirection = { x: 0, z: 1 };
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.targetDirection = { x: -1, z: 0 };
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.targetDirection = { x: 1, z: 0 };
        break;
      case 'Space':
      case 'ShiftLeft':
        this.boost = true;
        e.preventDefault();
        break;
    }
  };

  _onKeyUp = (e) => {
    if (e.code === 'Space' || e.code === 'ShiftLeft') {
      this.boost = false;
    }
  };

  _onJoyStart = (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    const rect = this.base.getBoundingClientRect();
    this.joystick.active = true;
    this.joystick.originX = rect.left + rect.width / 2;
    this.joystick.originY = rect.top + rect.height / 2;
    this._updateJoy(t.clientX, t.clientY);
  };

  _onJoyMove = (e) => {
    if (!this.joystick.active) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    this._updateJoy(t.clientX, t.clientY);
  };

  _onJoyEnd = (e) => {
    e.preventDefault();
    this.joystick.active = false;
    this.joystick.dx = 0;
    this.joystick.dy = 0;
    if (this.knob) {
      this.knob.style.transform = 'translate(-50%, -50%)';
    }
  };

  _updateJoy(clientX, clientY) {
    let dx = clientX - this.joystick.originX;
    let dy = clientY - this.joystick.originY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const max = this.joystick.maxRadius;
    if (dist > max) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    this.joystick.dx = dx;
    this.joystick.dy = dy;

    if (this.knob) {
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }

    if (dist > 8) {
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      this.targetDirection = {
        x: dx / len,
        z: dy / len,
      };
    }
  }

  _swipeStart = null;
  _onSwipeStart = (e) => {
    if (e.touches.length !== 1) return;
    this._swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  };

  _onSwipeMove = (e) => {};

  _onSwipeEnd = (e) => {
    if (!this._swipeStart || e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - this._swipeStart.x;
    const dy = t.clientY - this._swipeStart.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < 30) return;

    if (absX > absY) {
      this.targetDirection = { x: dx > 0 ? 1 : -1, z: 0 };
    } else {
      this.targetDirection = { x: 0, z: dy > 0 ? 1 : -1 };
    }
    this._swipeStart = null;
  };

  update(dt) {
    if (!this.enabled) return;
    this.direction.x = this.targetDirection.x;
    this.direction.z = this.targetDirection.z;
  }

  getDirection() {
    return this.direction;
  }

  isBoosting() {
    return this.boost;
  }

  setEnabled(v) {
    this.enabled = v;
  }

  showJoystick(show) {
    if (this.zone) {
      this.zone.classList.toggle('hidden', !show);
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
