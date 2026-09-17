package eapp

import (
	"fmt"
	"hash/fnv"
)

// Bootstrapper is the minimal Bootstrap Runtime of §12.1.
//
// §12.2 requires it to be as small as possible and forbids it from taking over
// the responsibilities of the Composition Core, the Interaction Layer or the
// Transport. It therefore does exactly three things and nothing else: it can
// mint an identity, it can load the first plugin, and it can hand out the
// initial discovery object. It does not schedule plugins, hold configuration,
// or know about channels.
//
// BR-1 ("Bootstrap MUST NOT be replaced by something that does not exist") and
// BR-2 ("Bootstrap MUST NOT depend on any Plugin") are properties of *how* it
// is constructed: a Bootstrapper wraps a Core the caller already owns and never
// consults a plugin to do its work, so a plugin cannot be a prerequisite for
// creating the runtime that would load it. BR-3 ("MUST provide at least one
// initial Discovery") is InitialDiscovery, which always answers with a usable
// view of the same Core rather than with nil.
type Bootstrapper struct {
	core *Core
	// mintSeq disambiguates identities minted from the same seed.
	mintSeq uint64
}

// NewBootstrapper creates a Bootstrap Runtime over core.
func NewBootstrapper(core *Core) *Bootstrapper {
	return &Bootstrapper{core: core}
}

// CreateIdentity implements `createIdentity(seed)` (§12.1).
//
// The seed is *folded into the instance name* rather than used as the instance
// verbatim: a seed is caller-chosen and therefore not unique (calling this twice
// with "root" would otherwise violate ID-3 on the second call), whereas ID-5
// says the runtime is what mints identities. The seed stays visible in the
// result so a caller can recognise the identity it asked for, and a per-seed
// counter keeps the whole thing unique.
//
// There is deliberately no rule about what a seed may be (`unknown` in the
// spec): it is rendered through %v, so any JSON value works.
func (b *Bootstrapper) CreateIdentity(seed any) (Identity, error) {
	instance := fmt.Sprintf("bootstrap-%s-%d", seedDigest(seed), b.mintSeq)
	b.mintSeq++
	return b.core.CreateIdentity(bootstrapDomain, "bootstrap", instance)
}

// bootstrapDomain is the naming domain used for identities the bootstrap owns.
const bootstrapDomain = "eapp.bootstrap"

// seedDigest renders a seed into a short, filename-safe digest.
//
// Hashing rather than embedding the seed keeps the instance name stable in
// length and free of separators that a caller could use to forge a longer name
// that collides with another seed's.
func seedDigest(seed any) string {
	hasher := fnv.New32a()
	fmt.Fprintf(hasher, "%v", seed)
	return fmt.Sprintf("%08x", hasher.Sum32())
}

// LoadFirstPlugin implements `loadFirstPlugin(ref)` (§12.1): it registers the
// plugin named by ref and returns it.
//
// `ref` is an Identity rather than a PluginRef-with-a-body because the Core does
// not carry plugin bodies: §5.1 freezes a Plugin to identity + capabilities +
// lifecycle, and the "loading" of whatever hosts the plugin is the caller's
// business. The plugin is registered with no capabilities (P-2 permits that),
// and the caller may declare capabilities afterwards.
//
// BR-2 holds by construction: nothing here looks at any plugin.
func (b *Bootstrapper) LoadFirstPlugin(ref Identity) (Plugin, error) {
	return b.core.Register(ref, nil)
}

// InitialDiscovery implements `provideInitialDiscovery()` (§12.1).
//
// It returns the Core itself, which satisfies the Discovery §8.1 interface
// through Find and Watch. Returning the same object every time is the point:
// §12.3 wants a *replaceable* root, and a bootstrap that manufactured a fresh,
// empty Discovery per call would quietly hide the graph from every consumer that
// asked twice.
func (b *Bootstrapper) InitialDiscovery() *Core {
	return b.core
}
