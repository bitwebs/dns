import { LookupEntry, ResolveContext } from './resolve-context'

declare namespace protocols {
  type Protocol = (context: ResolveContext, name: string) => Promise<LookupEntry | undefined>

  const dat: Protocol
  const bit: Protocol
  const ara: Protocol
  const cabal: Protocol
}

export = protocols