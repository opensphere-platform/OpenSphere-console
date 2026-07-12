export function shouldResetExistingTotp(status) {
  return Boolean(status?.primary);
}

export function credentialCommitError(state) {
  if (state?.can_commit === true) return null;
  const warnings = Array.isArray(state?.warnings)
    ? state.warnings
    : [state?.warnings].filter(Boolean);
  if (warnings.includes('MfaRequired')) {
    return 'This account policy requires MFA. Enable TOTP or correct the development authentication policy.';
  }
  return 'The password was accepted but the credential session is not ready to commit. Request a new reset token.';
}
