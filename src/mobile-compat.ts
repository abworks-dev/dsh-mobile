// Standalone browser entry: run before DSH evaluates its boot scripts or plugins.
// Use real iterator prototypes/helpers, not a placeholder global constructor.
import 'core-js/es/iterator/index.js'
import 'core-js/actual/iterator/join.js'
