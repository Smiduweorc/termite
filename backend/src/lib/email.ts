import { normalizeEmail } from "@grml/nomadic";

/**
 * Which mailbox an address actually reaches.
 *
 * `john.doe+termite@googlemail.com` and `johndoe@gmail.com` are one inbox, and until
 * something says so they are two accounts: two invites, two password resets, and a
 * "that email already has an account" that looks like a lie to the person holding it.
 * nomadic knows the per-provider rules - Gmail's dots and alias domain, Yahoo's `-`
 * tags, Microsoft's `+` - and collapses them to one canonical string.
 *
 * The default rule is deliberately timid. Lowercasing the local part everywhere only
 * restores what this codebase already did with `toLowerCase()`, so nobody's login
 * changes meaning. Stripping `+tags` from *unknown* domains is not added, tempting as it
 * is: on a self-hosted domain `+` may be an ordinary character, and collapsing two real
 * mailboxes into one account is a far worse failure than letting one person hold two.
 * Where the rules are known facts rather than guesses - the providers nomadic ships -
 * they are applied in full.
 */
const POLICY = { defaultRule: { lowercaseLocal: true } } as const;

export function canonicalEmail(email: string): string {
	return normalizeEmail(email, POLICY);
}
