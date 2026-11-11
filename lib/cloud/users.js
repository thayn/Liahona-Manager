// Managing manager accounts in Cognito: list, invite, change roles, disable,
// remove. Roles are Cognito groups (admin, planner, registrar, leader).
// `client` is a CognitoIdentityProviderClient; `cmd` holds the command classes
// (passed in so tests can use fakes).

import { HttpError } from '../store.js';
import { ROLES } from '../auth.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function cognitoUsers({ client, cmd, userPoolId }) {
  const attr = (u, name) => (u.Attributes || u.UserAttributes || []).find(a => a.Name === name)?.Value || '';

  async function groupsOf(username) {
    const r = await client.send(new cmd.AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username }));
    return (r.Groups || []).map(g => g.GroupName).filter(g => ROLES.includes(g));
  }

  async function setRoles(username, roles) {
    const want = new Set(roles.filter(r => ROLES.includes(r)));
    const have = new Set(await groupsOf(username));
    for (const r of want) if (!have.has(r)) await client.send(new cmd.AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: r }));
    for (const r of have) if (!want.has(r)) await client.send(new cmd.AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: r }));
  }

  async function adminCount() {
    const r = await client.send(new cmd.ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: 'admin' }));
    return (r.Users || []).filter(u => u.Enabled !== false).length;
  }

  return {
    async list() {
      const users = [];
      let token;
      do {
        const r = await client.send(new cmd.ListUsersCommand({ UserPoolId: userPoolId, PaginationToken: token, Limit: 60 }));
        for (const u of r.Users || []) {
          users.push({ username: u.Username, email: attr(u, 'email'), name: attr(u, 'name'), enabled: u.Enabled !== false,
            status: u.UserStatus, created: u.UserCreateDate, roles: await groupsOf(u.Username) });
        }
        token = r.PaginationToken;
      } while (token && users.length < 500);
      return users.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    },

    async invite({ email, name = '', roles = [] }) {
      email = String(email || '').trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email');
      if (!roles.length) throw new HttpError(400, 'Pick at least one role');
      try {
        const r = await client.send(new cmd.AdminCreateUserCommand({
          UserPoolId: userPoolId, Username: email, DesiredDeliveryMediums: ['EMAIL'],
          UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: String(name).slice(0, 80) }]
        }));
        await setRoles(r.User.Username, roles);
        return { username: r.User.Username, email, invited: true };
      } catch (e) {
        if (e.name === 'UsernameExistsException') throw new HttpError(409, 'That person already has an account');
        throw e;
      }
    },

    async update(username, { roles, enabled, name, resendInvite }, me) {
      if (roles) {
        if (username === me.email && !roles.includes('admin') && (await adminCount()) <= 1) throw new HttpError(409, 'You\'re the only Admin, so you can\'t remove your own Admin role');
        await setRoles(username, roles);
      }
      if (enabled === false) {
        if (username === me.email) throw new HttpError(409, 'You can\'t disable your own account');
        await client.send(new cmd.AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }));
      }
      if (enabled === true) await client.send(new cmd.AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username }));
      if (name !== undefined) await client.send(new cmd.AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: username, UserAttributes: [{ Name: 'name', Value: String(name).slice(0, 80) }] }));
      if (resendInvite) await client.send(new cmd.AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
      return { ok: true };
    },

    async remove(username, me) {
      if (username === me.email) throw new HttpError(409, 'You can\'t delete your own account');
      await client.send(new cmd.AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      return { ok: true };
    }
  };
}
