// src/onboarding/OnboardingFlow.js
// Phase 2 — onboarding: Complete Profile → Create/Join Couple →
// approval → private couple space. Renders into the #onboardingOverlay
// sheet (index.html). Talks to the legacy app via window.app.

const esc = (s) => {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
};

export class OnboardingFlow {
    constructor() {
        this.step = null;
        this.busy = false;
    }

    get overlay() { return document.getElementById('onboardingOverlay'); }

    start({ step = 'profile' } = {}) {
        const ov = this.overlay;
        if (!ov) return;
        this.step = step;
        this.busy = false;
        ov.classList.add('active');
        this.render();
    }

    close() {
        const ov = this.overlay;
        if (ov) ov.classList.remove('active');
        this.step = null;
    }

    go(step) { this.step = step; this.render(); }

    // ---------------- renderer ----------------

    render() {
        const title = document.getElementById('onbTitle');
        const sub = document.getElementById('onbSub');
        const form = document.getElementById('onbForm');
        const skip = document.getElementById('onbSkip');
        if (!title || !sub || !form) return;

        skip.style.display = 'block';
        form.innerHTML = '';

        switch (this.step) {
            case 'profile': this.renderProfile(title, sub, form); break;
            case 'couple-menu': this.renderCoupleMenu(title, sub, form); break;
            case 'couple-create': this.renderCreate(title, sub, form); break;
            case 'couple-join': this.renderJoin(title, sub, form); break;
            case 'status': this.renderStatus(title, sub, form, skip); break;
            case 'done': this.renderDone(title, sub, form, skip); break;
            default: this.renderCoupleMenu(title, sub, form);
        }
    }

    buildField(field, value) {
        const group = document.createElement('div');
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = field.label;
        group.appendChild(label);

        let input;
        if (field.type === 'textarea') {
            input = document.createElement('textarea');
            input.rows = 3;
            input.style.minHeight = '72px';
        } else if (field.type === 'select') {
            input = document.createElement('select');
            field.options.forEach((opt) => {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt;
                if (String(value) === opt) o.selected = true;
                input.appendChild(o);
            });
        } else {
            input = document.createElement('input');
            input.type = field.type;
        }
        input.className = 'login-field';
        input.value = value ?? '';
        input.dataset.field = field.key;
        group.appendChild(input);
        return group;
    }

    renderProfile(title, sub, form) {
        title.textContent = 'Complete your profile';
        sub.textContent = 'Tell your partner a little about you';
        const profile = window.app?.currentProfile || {};
        const fields = window.LoveHubProfile?.getDbFieldDefinitions() || [];
        fields.forEach((f) => form.appendChild(this.buildField(f, profile[f.key] ?? '')));

        const btn = document.createElement('button');
        btn.className = 'login-submit';
        btn.textContent = 'Save & Continue';
        btn.addEventListener('click', () => this.saveProfile());
        form.appendChild(btn);
    }

    renderCoupleMenu(title, sub, form) {
        title.textContent = 'Find your partner';
        sub.textContent = 'Create a couple and share your invite code, or join with theirs';

        const create = document.createElement('button');
        create.className = 'login-submit';
        create.textContent = 'Create Couple';
        create.style.background = 'linear-gradient(135deg, #FF375F, #FF6B9D)';
        create.addEventListener('click', () => this.go('couple-create'));

        const join = document.createElement('button');
        join.className = 'login-submit';
        join.textContent = 'Join Couple';
        join.style.background = 'linear-gradient(135deg, #5E5CE6, #8E8CF0)';
        join.addEventListener('click', () => this.go('couple-join'));

        form.appendChild(create);
        form.appendChild(join);
    }

    renderCreate(title, sub, form) {
        title.textContent = 'Create a couple';
        sub.textContent = 'Enter the exact email your partner uses to log in to LoveHub';

        const group = document.createElement('div');
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = "Partner's email";
        group.appendChild(label);
        const email = document.createElement('input');
        email.className = 'login-field';
        email.type = 'email';
        email.placeholder = 'partner@example.com';
        email.dataset.field = 'partnerEmail';
        group.appendChild(email);
        form.appendChild(group);

        const btn = document.createElement('button');
        btn.className = 'login-submit';
        btn.textContent = 'Create Invite';
        btn.addEventListener('click', () => this.createCouple(email.value.trim()));
        form.appendChild(btn);
    }

    renderJoin(title, sub, form) {
        title.textContent = 'Join a couple';
        sub.textContent = 'Enter the invite code and the email you signed up with';

        const fields = [
            { key: 'inviteCode', label: 'Invite code', type: 'text', placeholder: 'ABCD1234' },
            { key: 'email', label: 'Your email', type: 'email', placeholder: 'you@example.com' }
        ];
        const values = {};
        fields.forEach((f) => {
            const group = document.createElement('div');
            group.className = 'form-group';
            const label = document.createElement('label');
            label.textContent = f.label;
            group.appendChild(label);
            const input = document.createElement('input');
            input.className = 'login-field';
            input.type = f.type;
            input.placeholder = f.placeholder;
            input.dataset.field = f.key;
            values[f.key] = input;
            group.appendChild(input);
            form.appendChild(group);
        });

        const btn = document.createElement('button');
        btn.className = 'login-submit';
        btn.textContent = 'Send Request';
        btn.addEventListener('click', () => this.joinCouple(values.inviteCode.value.trim(), values.email.value.trim()));
        form.appendChild(btn);
    }

    renderDone(title, sub, form, skip) {
        skip.style.display = 'none';
        title.textContent = "You're all set";
        sub.textContent = 'Welcome to your private couple space';
        const btn = document.createElement('button');
        btn.className = 'login-submit';
        btn.textContent = 'Enter LoveHub';
        btn.addEventListener('click', () => {
            this.close();
            window.app?.refreshCouple();
        });
        form.appendChild(btn);
    }

    // ---------------- actions ----------------

    async saveProfile() {
        if (this.busy) return;
        const app = window.app;
        if (!app?.currentUser || !window.LoveHubProfile) return;

        const updates = {};
        this.overlay.querySelectorAll('[data-field]').forEach((input) => {
            let v = input.value;
            if (input.dataset.field === 'height' || input.dataset.field === 'weight') {
                v = v === '' ? null : Number(v);
            }
            if (input.dataset.field === 'date_of_birth') v = v === '' ? null : v;
            updates[input.dataset.field] = v;
        });

        if (!updates.display_name || !String(updates.display_name).trim()) {
            app.showToast('Please enter a display name');
            return;
        }

        this.busy = true;
        const res = await window.LoveHubProfile.updateProfile(app.currentUser.id, updates);
        this.busy = false;
        if (res.success) {
            await window.LoveHubProfile.markOnboardingComplete(app.currentUser.id);
            app.currentProfile = res.profile;
            app.showToast('Profile saved ❤️');
            this.go(app.currentCouple ? 'status' : 'couple-menu');
        } else {
            app.showToast(res.error || 'Could not save profile');
        }
    }

    async createCouple(partnerEmail) {
        if (this.busy) return;
        const app = window.app;
        if (!partnerEmail || partnerEmail.indexOf('@') < 0) {
            app?.showToast('Please enter a valid email');
            return;
        }
        this.busy = true;
        const res = await window.LoveHubCouple.createCouple(partnerEmail);
        this.busy = false;
        if (!res.success) {
            app?.showToast(res.error || 'Could not create couple');
            return;
        }
        await app.refreshCouple();
        app.showToast('Couple created — share your invite code');
        this.renderInviteCode(res.couple);
    }

    renderInviteCode(couple) {
        const title = document.getElementById('onbTitle');
        const sub = document.getElementById('onbSub');
        const form = document.getElementById('onbForm');
        const skip = document.getElementById('onbSkip');
        if (!title || !sub || !form) return;
        skip.style.display = 'block';

        title.textContent = 'Share your invite code';
        sub.textContent = 'Your partner enters this code and the email you provided';

        const box = document.createElement('div');
        box.style.textAlign = 'center';
        box.style.padding = '10px 0 18px';
        const code = document.createElement('div');
        code.style.cssText = 'font-size:30px;font-weight:800;letter-spacing:8px;color:#FF375F;margin-bottom:16px';
        code.textContent = couple.invite_code;
        box.appendChild(code);

        const copy = document.createElement('button');
        copy.className = 'login-submit';
        copy.textContent = 'Copy Invite Code';
        copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(couple.invite_code);
                app?.showToast('Invite code copied');
            } catch (e) {
                window.prompt('Copy your invite code:', couple.invite_code);
            }
        });
        box.appendChild(copy);

        const wait = document.createElement('button');
        wait.className = 'login-submit';
        wait.textContent = "I'll wait for my partner";
        wait.style.background = 'rgba(255,255,255,0.12)';
        wait.style.color = 'var(--text-primary, #fff)';
        wait.addEventListener('click', () => {
            this.close();
            window.app?.refreshCouple();
        });
        box.appendChild(wait);

        form.innerHTML = '';
        form.appendChild(box);
    }

    async joinCouple(inviteCode, email) {
        if (this.busy) return;
        const app = window.app;
        if (!inviteCode || !email || email.indexOf('@') < 0) {
            app?.showToast('Please enter the invite code and your email');
            return;
        }
        this.busy = true;
        const res = await window.LoveHubCouple.joinCouple(inviteCode, email);
        this.busy = false;
        if (!res.success) {
            app?.showToast(res.error || 'Could not send request');
            return;
        }
        app.showToast('Request sent — waiting for approval');
        this.go('status');
    }

    renderStatus(title, sub, form, skip) {
        const app = window.app;
        const couple = app?.currentCouple;
        if (!couple) {
            this.go('couple-menu');
            return;
        }

        if (couple.status === 'active') {
            skip.style.display = 'block';
            title.textContent = "You're connected";
            const partnerName = couple.partner?.display_name || 'your partner';
            sub.textContent = `You and ${partnerName} are officially a couple ❤️`;
            const done = document.createElement('button');
            done.className = 'login-submit';
            done.textContent = 'Done';
            done.addEventListener('click', () => {
                this.close();
                window.app?.refreshCouple();
            });
            form.appendChild(done);
            return;
        }

        if (couple.created_by === app.currentUser.id) {
            // Creator, pending: code + requests to approve
            title.textContent = 'Your invite is active';
            sub.textContent = 'Review join requests below';
            this.renderCreatorStatus(form, couple);
        } else {
            title.textContent = 'Request sent';
            sub.textContent = `Waiting for ${couple.partner_email || 'your partner'} to accept`;
            const refresh = document.createElement('button');
            refresh.className = 'login-submit';
            refresh.textContent = 'Check status';
            refresh.addEventListener('click', async () => {
                await app.refreshCouple();
                this.renderStatus(title, sub, form, skip);
            });
            form.appendChild(refresh);
        }
    }

    async renderCreatorStatus(form, couple) {
        const app = window.app;

        const codeBox = document.createElement('div');
        codeBox.style.textAlign = 'center';
        codeBox.style.padding = '0 0 14px';
        codeBox.innerHTML = `<div style="font-size:13px;color:var(--text-secondary, #999);margin-bottom:6px">Invite code</div>
            <div style="font-size:26px;font-weight:800;letter-spacing:6px;color:#FF375F">${esc(couple.invite_code)}</div>`;
        form.appendChild(codeBox);

        const list = document.createElement('div');
        list.id = 'onbRequests';
        list.style.marginBottom = '10px';
        form.appendChild(list);

        const refresh = document.createElement('button');
        refresh.className = 'login-submit';
        refresh.textContent = 'Refresh';
        refresh.addEventListener('click', () => this.refreshRequests());
        form.appendChild(refresh);

        const cancel = document.createElement('button');
        cancel.className = 'login-submit';
        cancel.textContent = 'Cancel Couple';
        cancel.style.background = 'rgba(255,59,48,0.25)';
        cancel.addEventListener('click', async () => {
            if (!window.confirm('Cancel this couple? Your invite code will stop working.')) return;
            const res = await window.LoveHubCouple.cancelCouple(couple.id);
            if (res.success) {
                app.showToast('Couple cancelled');
                await app.refreshCouple();
                this.go('couple-menu');
            } else {
                app.showToast(res.error || 'Could not cancel');
            }
        });
        form.appendChild(cancel);

        this.refreshRequests();
    }

    async refreshRequests() {
        const app = window.app;
        const list = document.getElementById('onbRequests');
        const couple = app?.currentCouple;
        if (!list || !couple) return;

        const requests = await window.LoveHubCouple.getPendingRequests(couple.id);
        if (!requests.length) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-secondary, #999);font-size:13px;padding:8px 0">No requests yet</div>';
            return;
        }

        list.innerHTML = '';
        for (const req of requests) {
            const card = document.createElement('div');
            card.className = 'glass-card';
            card.style.padding = '12px';
            card.style.marginBottom = '10px';

            const name = req.requester?.display_name || req.requester?.username || 'Someone';
            const initial = (req.requester?.display_name || req.requester?.username || '?')[0]?.toUpperCase() || '?';

            card.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <div class="avatar-circle" style="width:36px;height:36px;font-size:14px">${esc(initial)}</div>
                    <div style="flex:1;font-size:14px;font-weight:600">${esc(name)}</div>
                </div>
                <div style="display:flex;gap:8px">
                    <button class="login-submit" style="flex:1;margin:0;font-size:13px;background:linear-gradient(135deg,#30D158,#57E389)" data-approve="${req.id}">Approve</button>
                    <button class="login-submit" style="flex:1;margin:0;font-size:13px;background:rgba(255,59,48,0.35)" data-decline="${req.id}">Decline</button>
                </div>`;

            card.querySelector('[data-approve]').addEventListener('click', () => this.respond(req.id, true));
            card.querySelector('[data-decline]').addEventListener('click', () => this.respond(req.id, false));
            list.appendChild(card);
        }
    }

    async respond(requestId, approve) {
        if (this.busy) return;
        const app = window.app;
        this.busy = true;
        const res = await window.LoveHubCouple.respondToRequest(requestId, approve);
        this.busy = false;
        if (!res.success) {
            app?.showToast(res.error || 'Could not process request');
            return;
        }
        app.showToast(approve ? 'Request approved — you are now a couple ❤️' : 'Request declined');
        await app.refreshCouple();
        this.refreshRequests();
    }
}
