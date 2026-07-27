package collect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// Fixed binary paths. Nothing here is resolved from PATH and nothing is ever
// taken from configuration or from a plan: a PATH lookup is an execution
// surface handed to whoever controls the environment.
var (
	ipPaths    = []string{"/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip"}
	nmcliPaths = []string{"/usr/bin/nmcli", "/bin/nmcli"}
)

// Markers for network managers this build reports but does not drive.
var foreignNetworkManagers = []struct {
	manager string
	marker  string
}{
	{snapshot.NetManagerNetplan, "/usr/sbin/netplan"},
	{snapshot.NetManagerNetworkd, "/usr/lib/systemd/systemd-networkd"},
	{snapshot.NetManagerNetworkd, "/lib/systemd/systemd-networkd"},
}

const (
	networkProbeTimeout = 20 * time.Second
	networkProbeMaxRead = 256 * 1024
	// Per-connection detail is one exec each, so the number of connections
	// inspected is bounded rather than the number NetworkManager happens to
	// have defined.
	maxInspectedConnections = 16
)

// Compile-time argv. There is no mechanism anywhere to add, reorder or template
// any of these.
var (
	ipAddrArgv         = []string{"-json", "-details", "addr", "show"}
	ipDefaultRouteArgv = []string{"-json", "route", "show", "default"}
	nmcliDeviceArgv    = []string{"-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"}
	nmcliConnListArgv  = []string{"-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show", "--active"}
)

// nmcliDetailFields are the only settings this agent ever reads back. Keeping
// the list closed means a future NetworkManager version cannot start returning
// a secret in a field the collector blindly forwards. In particular no
// `802-11-wireless-security.*` field is ever requested.
var nmcliDetailFields = "connection.id,connection.interface-name,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns,802-3-ethernet.mtu"

// probeNetwork collects the read-only network inventory.
func probeNetwork(ctx context.Context, now time.Time) (snapshot.NetworkState, error) {
	state := snapshot.NetworkState{
		Manager:     snapshot.NetManagerUnknown,
		Links:       []snapshot.NetworkLink{},
		DNS:         snapshot.DNSState{Servers: []string{}, Search: []string{}},
		CollectedAt: now.UTC().Format(time.RFC3339),
	}

	manager, supported, reason := detectNetworkManager()
	state.Manager = manager
	state.Supported = supported
	state.UnsupportedReason = reason

	ipBinary := firstExisting(ipPaths)
	if ipBinary == "" {
		// Without `ip` the link inventory cannot be read at all. Reporting an
		// empty link list would read as "this host has no interfaces".
		state.Supported = false
		state.UnsupportedReason = "the ip(8) utility is not present, so link state cannot be read"
		state.DNS = readResolverState()
		return state, errNoIPUtility
	}

	if raw, err := runBounded(ctx, networkProbeTimeout, networkProbeMaxRead, ipBinary, ipAddrArgv); err == nil {
		state.Links = parseIPAddr(raw)
	} else if len(raw) == 0 {
		state.Supported = false
		state.UnsupportedReason = "the link inventory could not be read: " + err.Error()
		state.DNS = readResolverState()
		return state, err
	}

	if raw, err := runBounded(ctx, networkProbeTimeout, networkProbeMaxRead, ipBinary, ipDefaultRouteArgv); err == nil {
		state.DefaultRoute = parseIPDefaultRoute(raw)
	}

	for i := range state.Links {
		state.Links[i].Driver = linkDriver(state.Links[i].Name)
	}

	if state.Supported {
		annotateFromNetworkManager(ctx, &state)
	}
	state.DNS = readResolverState()
	sort.SliceStable(state.Links, func(i, j int) bool {
		return state.Links[i].Name < state.Links[j].Name
	})
	return state, nil
}

// errNoIPUtility marks the collector as degraded rather than merely empty.
var errNoIPUtility = &collectError{"ip(8) is not installed"}

type collectError struct{ message string }

func (e *collectError) Error() string { return e.message }

// detectNetworkManager reports which manager owns this host's configuration.
//
// Only NetworkManager can be driven. The others are detected purely so the
// console can say "systemd-networkd is in charge and this platform does not
// reconfigure it" rather than leaving an operator to guess why the controls are
// off.
func detectNetworkManager() (manager string, supported bool, reason string) {
	if firstExisting(nmcliPaths) != "" {
		return snapshot.NetManagerNM, true, ""
	}
	for _, foreign := range foreignNetworkManagers {
		if firstExisting([]string{foreign.marker}) != "" {
			return foreign.manager, false,
				"this agent build drives NetworkManager only; " + foreign.manager +
					" is in use on this host and is reported read-only"
		}
	}
	return snapshot.NetManagerUnknown, false,
		"no network manager this agent can drive was found; link state is reported read-only"
}

// ipAddrEntry mirrors only the fields this collector consumes. Anything else
// `ip` prints is discarded by the decoder rather than carried along.
type ipAddrEntry struct {
	IfName    string `json:"ifname"`
	MTU       int    `json:"mtu"`
	OperState string `json:"operstate"`
	LinkType  string `json:"link_type"`
	LinkInfo  struct {
		InfoKind string `json:"info_kind"`
	} `json:"linkinfo"`
	AddrInfo []struct {
		Family    string `json:"family"`
		Local     string `json:"local"`
		PrefixLen int    `json:"prefixlen"`
		Scope     string `json:"scope"`
	} `json:"addr_info"`
}

// parseIPAddr turns `ip -json addr show` into bounded link records.
func parseIPAddr(raw []byte) []snapshot.NetworkLink {
	var entries []ipAddrEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return []snapshot.NetworkLink{}
	}
	links := make([]snapshot.NetworkLink, 0, len(entries))
	for _, entry := range entries {
		name := bound(strings.TrimSpace(entry.IfName), 32)
		if name == "" {
			continue
		}
		kind := entry.LinkInfo.InfoKind
		if kind == "" {
			kind = entry.LinkType
		}
		link := snapshot.NetworkLink{
			Name:            name,
			Type:            bound(kind, 32),
			State:           bound(strings.ToLower(entry.OperState), 16),
			MTU:             entry.MTU,
			Addresses:       []string{},
			StaticAddresses: []string{},
		}
		if link.State == "" {
			link.State = "unknown"
		}
		for _, addr := range entry.AddrInfo {
			if addr.Local == "" {
				continue
			}
			// Link-local addresses are noise for an operator deciding what to
			// change and there can be many of them.
			if addr.Scope == "link" {
				continue
			}
			if len(link.Addresses) >= snapshot.MaxLinkAddresses {
				link.Truncated = true
				break
			}
			link.Addresses = append(link.Addresses,
				bound(addr.Local+"/"+strconv.Itoa(addr.PrefixLen), 64))
		}
		links = append(links, link)
		if len(links) >= snapshot.MaxLinks {
			break
		}
	}
	return links
}

type ipRouteEntry struct {
	Dst     string `json:"dst"`
	Gateway string `json:"gateway"`
	Dev     string `json:"dev"`
	Metric  int    `json:"metric"`
}

// parseIPDefaultRoute picks the route the host actually uses.
//
// When several default routes exist the kernel prefers the lowest metric, so
// that is the one reported: it is the interface the control center is reached
// through, and therefore the one this platform must never disturb.
func parseIPDefaultRoute(raw []byte) snapshot.DefaultRoute {
	var entries []ipRouteEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return snapshot.DefaultRoute{}
	}
	best := snapshot.DefaultRoute{}
	for _, entry := range entries {
		if entry.Dst != "default" || entry.Dev == "" {
			continue
		}
		candidate := snapshot.DefaultRoute{
			Present:   true,
			Interface: bound(entry.Dev, 32),
			Gateway:   bound(entry.Gateway, 64),
			Metric:    entry.Metric,
		}
		if !best.Present || candidate.Metric < best.Metric {
			best = candidate
		}
	}
	return best
}

// linkDriver reads the kernel driver bound to an interface.
func linkDriver(name string) string {
	if name == "" || strings.ContainsAny(name, "/.") {
		return ""
	}
	target, err := os.Readlink(filepath.Join("/sys/class/net", name, "device", "driver"))
	if err != nil {
		return ""
	}
	return bound(filepath.Base(target), 48)
}

// annotateFromNetworkManager adds the manager's own view of each link.
func annotateFromNetworkManager(ctx context.Context, state *snapshot.NetworkState) {
	binary := firstExisting(nmcliPaths)
	if binary == "" {
		return
	}

	byName := map[string]*snapshot.NetworkLink{}
	for i := range state.Links {
		byName[state.Links[i].Name] = &state.Links[i]
	}

	if raw, err := runBounded(ctx, networkProbeTimeout, networkProbeMaxRead, binary, nmcliDeviceArgv); err == nil {
		for _, fields := range parseNmcliTerse(raw, 4) {
			link := byName[bound(fields[0], 32)]
			if link == nil {
				continue
			}
			// "unmanaged" is NetworkManager saying it will not touch this link.
			// A link it does not manage cannot be reconfigured through it.
			link.Managed = fields[2] != "unmanaged" && fields[2] != ""
			link.Connection = bound(fields[3], 128)
		}
	}

	raw, err := runBounded(ctx, networkProbeTimeout, networkProbeMaxRead, binary, nmcliConnListArgv)
	if err != nil {
		return
	}
	inspected := 0
	for _, fields := range parseNmcliTerse(raw, 4) {
		device := bound(fields[3], 32)
		link := byName[device]
		if link == nil || fields[1] == "" {
			continue
		}
		if inspected >= maxInspectedConnections {
			state.Truncated = true
			break
		}
		inspected++
		// The uuid comes from nmcli's own output, and is passed as its own argv
		// element after `--`, so it can never be read as a flag.
		detail, detailErr := runBounded(ctx, networkProbeTimeout, networkProbeMaxRead, binary, []string{
			"-t", "-f", nmcliDetailFields, "connection", "show", "--", fields[1],
		})
		if detailErr != nil && len(detail) == 0 {
			continue
		}
		for _, pair := range parseNmcliTerse(detail, 2) {
			switch pair[0] {
			case "ipv4.method":
				link.Method = bound(pair[1], 32)
			case "ipv4.addresses":
				link.StaticAddresses = boundList(pair[1], snapshot.MaxLinkAddresses, 64)
			case "ipv4.gateway":
				link.Gateway = bound(pair[1], 64)
			}
		}
	}
}

// parseNmcliTerse splits nmcli's terse output.
//
// nmcli escapes a literal colon inside a value as `\:`, so a naive Split would
// silently shift every field after an IPv6 address or a connection name that
// contains one.
//
// Unset values arrive as the two-character sentinel `--`, which is a display
// convention and not a value. Stripping it here rather than at each field is
// deliberate: a reported `--` becomes part of the pre-state bound into the
// approved plan, and the agent then compares that literal against a real
// setting it can never equal, so the operation is refused every time it runs.
func parseNmcliTerse(raw []byte, fields int) [][]string {
	out := [][]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := splitTerse(line)
		if len(parts) < fields {
			continue
		}
		row := make([]string, fields)
		for i := 0; i < fields; i++ {
			row[i] = nmcliValue(parts[i])
		}
		// The last requested field absorbs any remainder, so a value containing
		// an unescaped separator is not silently cut in half.
		if len(parts) > fields {
			row[fields-1] = nmcliValue(strings.Join(parts[fields-1:], ":"))
		}
		out = append(out, row)
	}
	return out
}

// nmcliValue trims a terse field and resolves nmcli's unset sentinel.
func nmcliValue(field string) string {
	field = strings.TrimSpace(field)
	if field == "--" {
		return ""
	}
	return field
}

// boundList splits nmcli's comma-separated list values under both bounds.
func boundList(value string, maxEntries, maxChars int) []string {
	out := []string{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" || part == "--" {
			continue
		}
		if len(out) >= maxEntries {
			break
		}
		out = append(out, bound(part, maxChars))
	}
	return out
}

func splitTerse(line string) []string {
	parts := []string{}
	current := strings.Builder{}
	escaped := false
	for _, r := range line {
		if escaped {
			current.WriteRune(r)
			escaped = false
			continue
		}
		switch r {
		case '\\':
			escaped = true
		case ':':
			parts = append(parts, current.String())
			current.Reset()
		default:
			current.WriteRune(r)
		}
	}
	parts = append(parts, current.String())
	return parts
}

// resolverFiles are the only resolver sources read, in preference order.
var resolverFiles = []struct {
	path   string
	source string
}{
	{"/run/systemd/resolve/resolv.conf", "systemd-resolved"},
	{"/etc/resolv.conf", "/etc/resolv.conf"},
}

// readResolverState reads nameservers and search domains.
//
// resolv.conf carries no credential and no key, which is why it is the only
// resolver source read. No wireless, VPN or 802.1X configuration is opened
// anywhere in this package.
func readResolverState() snapshot.DNSState {
	state := snapshot.DNSState{Servers: []string{}, Search: []string{}}
	for _, candidate := range resolverFiles {
		data, err := os.ReadFile(candidate.path)
		if err != nil {
			continue
		}
		if len(data) > 64*1024 {
			data = data[:64*1024]
		}
		state.Source = candidate.source
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			switch fields[0] {
			case "nameserver":
				if len(state.Servers) < snapshot.MaxDNSServers {
					state.Servers = append(state.Servers, bound(fields[1], 64))
				}
			case "search", "domain":
				for _, domain := range fields[1:] {
					if len(state.Search) >= snapshot.MaxSearchDomains {
						break
					}
					state.Search = append(state.Search, bound(domain, 128))
				}
			}
		}
		// systemd-resolved's stub file lists only 127.0.0.53, which tells an
		// operator nothing; fall through to the real one when that is all it has.
		if len(state.Servers) == 1 && strings.HasPrefix(state.Servers[0], "127.0.0.5") {
			continue
		}
		if len(state.Servers) > 0 {
			return state
		}
	}
	return state
}
