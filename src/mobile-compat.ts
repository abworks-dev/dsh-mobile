// Standalone browser entry: run before DSH evaluates its boot scripts or plugins.
import 'core-js/es/iterator/index.js'
import 'core-js/actual/iterator/join.js'
import 'core-js/es/promise/with-resolvers.js'
import { installAbortSignalAny } from './mobile-abort-signal.js'

installAbortSignalAny()
