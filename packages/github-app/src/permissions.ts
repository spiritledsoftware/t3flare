// The GitHub permissions t3flare asks for (ADR-0013).
// One list per kind of token (Container, skill fetch, update dispatch), so a permission the App gains reaches such a token
// only by being added to its list on purpose. The Environment token is the exception: it takes all the installation grants.

/** A permission's level (on a repository, an organization, an enterprise or the account). */
export type GitHubPermissionLevel = "read" | "write" | "admin";

/** A set of GitHub permissions: each permission's name and its level. */
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionLevel>>;

/**
 * What the App asks for when it is registered: every permission the owner's App holds, on repositories, organizations,
 * enterprises and the account (owner, 2026-11-26: the App acts as the owner would). Each token narrows it to its own
 * list, but the Environment token, which takes all the installation grants. No webhooks. An existing App's permissions
 * are changed in its settings on GitHub, not here; each installation then accepts them.
 */
export const GITHUB_APP_PERMISSIONS = {
  actions: "write",
  actions_variables: "write",
  administration: "write",
  agent_secrets: "write",
  agent_tasks: "write",
  agent_variables: "write",
  artifact_metadata: "write",
  attestations: "write",
  blocking: "write",
  checks: "write",
  code_quality: "write",
  codespaces: "write",
  codespaces_lifecycle_admin: "write",
  codespaces_metadata: "read",
  codespaces_secrets: "write",
  codespaces_user_secrets: "write",
  contents: "write",
  copilot_agent_settings: "write",
  copilot_editor_context: "read",
  copilot_messages: "read",
  custom_properties_for_organizations: "write",
  dependabot_secrets: "write",
  deployments: "write",
  discussions: "write",
  emails: "write",
  enterprise_access_restrictions: "write",
  enterprise_ai_controls: "write",
  enterprise_billing: "write",
  enterprise_bypass_requests: "read",
  enterprise_copilot_licenses: "write",
  enterprise_copilot_metrics: "read",
  enterprise_copilot_usage: "read",
  enterprise_credentials: "write",
  enterprise_custom_enterprise_roles: "write",
  enterprise_custom_org_roles: "write",
  enterprise_custom_properties: "write",
  enterprise_custom_properties_for_organizations: "admin",
  enterprise_delegate_policies: "write",
  enterprise_innersource_vulnerabilities: "write",
  enterprise_ip_allow_list: "write",
  enterprise_license_policy: "write",
  enterprise_organization_installation_repositories: "write",
  enterprise_organization_installations: "write",
  enterprise_organizations: "write",
  enterprise_people: "write",
  enterprise_ref_rules: "write",
  enterprise_scim: "write",
  enterprise_security_products: "write",
  enterprise_settings: "write",
  enterprise_sso: "write",
  enterprise_teams: "write",
  enterprise_two_factor_authentication: "write",
  enterprise_verifiable_domains: "write",
  environments: "write",
  followers: "write",
  gists: "write",
  git_signing_ssh_public_keys: "write",
  gpg_keys: "write",
  installation_repositories: "write",
  interaction_limits: "write",
  issue_fields: "write",
  issue_types: "write",
  issues: "write",
  keys: "write",
  license_compliance_alerts: "write",
  members: "write",
  merge_queues: "write",
  metadata: "read",
  org_copilot_content_exclusion: "write",
  organization_actions_variables: "write",
  organization_administration: "write",
  organization_agent_secrets: "write",
  organization_agent_variables: "write",
  organization_announcement_banners: "write",
  organization_api_insights: "read",
  organization_campaigns: "write",
  organization_code_scanning_dismissal_requests: "write",
  organization_codespaces: "write",
  organization_codespaces_secrets: "write",
  organization_codespaces_settings: "write",
  organization_copilot_agent_settings: "write",
  organization_copilot_metrics: "read",
  organization_copilot_requests: "read",
  organization_copilot_seat_management: "write",
  organization_copilot_spaces: "write",
  organization_credentials: "write",
  organization_custom_org_roles: "write",
  organization_custom_properties: "admin",
  organization_custom_roles: "write",
  organization_dependabot_dismissal_requests: "write",
  organization_dependabot_secrets: "write",
  organization_events: "read",
  organization_external_properties_for_repos: "admin",
  organization_hooks: "write",
  organization_innersource_vulnerabilities: "write",
  organization_ip_allow_list: "write",
  organization_models: "read",
  organization_network_configurations: "write",
  organization_personal_access_token_requests: "write",
  organization_personal_access_tokens: "write",
  organization_plan: "read",
  organization_private_registries: "write",
  organization_projects: "admin",
  organization_runner_custom_images: "write",
  organization_secret_scanning_bypass_requests: "write",
  organization_secrets: "write",
  organization_self_hosted_runners: "write",
  organization_user_blocking: "write",
  organization_verifiable_domains: "write",
  packages: "write",
  pages: "write",
  plan: "read",
  plugin_gateway_connections: "write",
  profile: "write",
  pull_requests: "write",
  repo_secret_scanning_dismissal_requests: "write",
  repository_advisories: "write",
  repository_creation: "write",
  repository_custom_properties: "write",
  repository_hooks: "write",
  repository_license_policy: "read",
  repository_projects: "admin",
  secret_scanning_alerts: "write",
  secret_scanning_bypass_requests: "write",
  secret_scanning_dismissal_requests: "write",
  secrets: "write",
  security_events: "write",
  starring: "write",
  statuses: "write",
  user_events: "read",
  user_issue_fields: "write",
  user_issue_types: "write",
  user_models: "read",
  vulnerability_alerts: "write",
  watching: "write",
  workflows: "write",
} as const satisfies GitHubPermissions;

/**
 * A Workspace's Container token (git and gh there; the agent can read it): one repo, code and pull requests writable,
 * as before SPI-992 (owner, 2026-11-12, back to stock: no push gateway). No `workflows` unless the Workspace is opted
 * in (`CONTAINER_WORKFLOWS_PERMISSIONS`).
 */
export const CONTAINER_GITHUB_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const satisfies GitHubPermissions;

/** A Container token for a Workspace the owner opted in to changing CI. */
export const CONTAINER_WORKFLOWS_PERMISSIONS = {
  ...CONTAINER_GITHUB_PERMISSIONS,
  workflows: "write",
} as const satisfies GitHubPermissions;

/** The Container token's permissions for a Workspace, by its `workflows` opt-in. */
export const containerGitHubPermissions = (workflows: boolean): GitHubPermissions =>
  workflows ? CONTAINER_WORKFLOWS_PERMISSIONS : CONTAINER_GITHUB_PERMISSIONS;

/**
 * The Environment DO's own token for t3's PR and issue features: every permission the installation grants (owner,
 * 2026-11-26: t3's tools act as the owner would), so `undefined`, which a mint reads as the installation's own. It never
 * reaches a Container or a Session; a Container's token keeps its narrow list, since the agent can read it.
 */
export const ENVIRONMENT_GITHUB_PERMISSIONS = undefined;

/**
 * The Environment DO's token for t3's lookup of a repository a Project is added from (SPI-1398): that one repo's
 * metadata, for its clone URLs, and nothing else. Kept by the Environment DO's minters until it expires and reused for
 * the same repo's next lookup; never a Container's or a Session's.
 */
export const REPOSITORY_LOOKUP_GITHUB_PERMISSIONS = {
  metadata: "read",
} as const satisfies GitHubPermissions;

/**
 * The Environment DO's token for reading Environment skills from GitHub (SPI-1148, ADR-0033): one repo's contents, read
 * only, used for the fetch's own requests and dropped. Scoped to an installed repo, it also reads public repos outside
 * the installation (docs-archive-1:docs/steps/spi-1001-env-plan.md §1, R1).
 */
export const SKILL_FETCH_GITHUB_PERMISSIONS = {
  contents: "read",
  metadata: "read",
} as const satisfies GitHubPermissions;

/**
 * The Environment DO's token for an in-app Update (ADR-0037): dispatch t3flare's bump workflows and read their runs, on
 * the repository the update target names only. Minted per dispatch and per poll, used for those
 * requests and dropped; never a Container's or a Session's.
 */
export const UPDATE_DISPATCH_GITHUB_PERMISSIONS = {
  actions: "write",
  metadata: "read",
} as const satisfies GitHubPermissions;
