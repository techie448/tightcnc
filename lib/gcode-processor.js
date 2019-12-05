const zstreams = require('zstreams');
const GcodeLine = require('./gcode-line');

class GcodeProcessor extends zstreams.Transform {

	/**
	 * This is the superclass for gcode processor streams.  Gcode processors can transform and analyze gcode
	 * and can be chained together.
	 *
	 * @class GcodeProcessor
	 * @constructor
	 * @param {Object} options - Any options used to configure the gcode processor.  If this is executed
	 *   in the context of an OperationManager, the 'opmanager' option will provide a reference to it.
	 * @param {String} name - The name of this gcode processor.  Should be hardcoded in the subclass.
	 * @param {Boolean} [modifiedGcode=true] - Set to false if this processor only records gcode lines
	 *   without modifying them.  (Adding additional properties that don't affect the gcode itself doesn't
	 *   count as modification)
	 */
	constructor(options, name, modifiesGcode = true) {
		super({ objectMode: true });
		this.gcodeProcessorName = name;
		this.modifiesGcode = modifiesGcode;
		this.processorOptions = options || {};
		this.preprocessInputGcode = () => {
			// This function is filled in later prior to initialization
			throw new XError(XError.INTERNAL_ERROR, 'Cannot call preprocessInputGcode outside of initProcessor()');
		};
	}

	/**
	 * This method is called to append this gcode processor to the end of a gcode processor chain.  Normally,
	 * it will just push itself onto the array.  It can also ensure that prerequisite processors are appended
	 * to the chain before this one, and that extra processors (for example, to update line numbers) are
	 * appended after this one.
	 *
	 * This method is called before initProcessor(), and is called on each processor in the chain, in order.
	 *
	 * @method addToChain
	 * @param {GcodeProcessor[]} processorChain - Array of GcodeProcessor instances in the chain so far.
	 */
	addToChain(processorChain) {
		processorChain.push(this);
	}

	/**
	 * Initializes the processor stream.  This is called in order on gcode processors in a stream.  It may
	 * return a promise.  It may also call this.preprocessInputGcode() to "dry run" through all gcode
	 * being input to this processor (for example, to compute needed data from the whole file).
	 *
	 * @method initProcessor
	 */
	initProcessor() {}

	/**
	 * This method must be implemented by subclasses.  It should construct AND initialize a copy of this instance,
	 * including any data already computed by initialization.  This method will only be called after this instance
	 * is already initialized.  It is used to minimize reprocessing of data during initialization.
	 *
	 * The default implementation is just to reconstruct and reinitialize this class, which should work as
	 * long as initialization isn't doing any "heavy" work.  Essentially, if initProcessor() calls
	 * preprocessInputGcode(), then copyProcessor() should be overridden to copy the results instead of
	 * calling preprocessInputGcode again().
	 *
	 * @method copyProcessor
	 * @return {GcodeProcessor|Promise{GcodeProcessor}} - A copy of this instance, already initialized.
	 */
	async copyProcessor() {
		let c = new (this.constructor)(this.processorOptions);
		c.preprocessInputGcode = this.preprocessInputGcode;
		await c.initProcessor();
		return c;
	}

	/**
	 * This method is added by buildProcessorChain during the processor chain initialization process, so it's
	 * not a "real" class method.  It can be used only inside of initProcessor() to preprocess incoming gcode.
	 * All preprocessed gcode is run through all prior gcode processors in the chain.
	 *
	 * @method preprocessInputGcode
	 * @return {ReadableStream} - This function returns a readable object stream that outputs GcodeLine instances.
	 *   After the readable stream ends, it will also contain a property `gcodeProcessorChain` which is an array
	 *   of all of the prior processor instances in the chain that were used to preprocess data.  This property
	 *   can be used to retrieve status information from these prior gcode processors.
	 */
	//preprocessInputGcode() { ... }

	/**
	 * Override in subclass.  This method is called for each line of gcode, with a GcodeLine instance.  The line
	 * may be transformed or analyzed.  When done, return the line to be sent to the next stage.
	 *
	 * This function can also return a promise, or an array of GcodeLine's, or null (to not forward on the line).
	 *
	 * @method processGcode
	 * @param {GcodeLine} gline
	 * @return {GcodeLine|GcodeLine[]|Promise|null}
	 */
	processGcode(gline) {}

	/**
	 * Override this method to flush any cached gcode remaining.  Analog of transform stream _flush.
	 *
	 * @method flushGcode
	 * @return {GcodeLine|GcodeLine[]|Promise|null}
	*/
	flushGcode() {}

	pushGcode(gline) {
		if (!gline) return;
		if (Array.isArray(gline)) {
			for (let l of gline) this.push(l);
		} else {
			this.push(gline);
		}
	}

	_transform(chunk, encoding, cb) {
		let r = this.processGcode(chunk);
		if (r && typeof r.then === 'function') {
			r.then((r2) => {
				this.pushGcode(r2);
				cb();
			}, (err) => {
				cb(err);
			});
		} else {
			this.pushGcode(r);
			cb();
		}
	}

	_flush(cb) {
		let r = this.flushGcode();
		if (r && typeof r.then === 'function') {
			r.then((r2) => {
				this.pushGcode(r2);
				cb();
			}, (err) => {
				cb(err);
			});
		} else {
			this.pushGcode(r);
			cb();
		}
	}

}

// filename can be either a filename, or an array of string gcode lines
function makeSourceStream(filename) {
	let lineStream;
	if (Array.isArray(filename)) {
		lineStream = zstreams.fromArray(filename);
	} else {
		lineStream = zstreams.fromFile(filename).pipe(new zstreams.SplitStream(/\r?\n/));
	}
	return lineStream.through((lineStr) => new GcodeLine(lineStr));
}

/**
 * Constructs and initializes a chain of gcode processors.
 *
 * @method buildProcessorChain
 * @static
 * @param {String|String[]} filename - This is either a filename of the gcode file to read, or
 *   it's an array of strings containing the gcode data (one array element per gcode line).
 * @param {GcodeProcessor[]} processors - An array of constructed, but not initialized, gcode processor
 *   instances.  These will be added to the chain in order.  It's possible that the chain may contain
 *   additional processors not in this list if a processor's addToChain() method appends any.
 * @param {Boolean} [stringifyLines=true] - If true, the returned stream is a readable data stream containing
 *   a single stream of data.  If false, the returned stream is a readable object stream of GcodeLine objects.
 * @return {Promise{ReadableStream}} - A readable stream for the output of the chain.  It's either
 *   a readable data stream or a readable object stream (of GcodeLine objects) depending
 *   on the value of the stringifyLines parameter.  The ReadableStream will also have a property
 *   `gcodeProcessorChain` that contains an array of all of the gcode processors used, and can be used
 *   to retrieve state data from processors.
 */
async function buildProcessorChain(filename, processors, stringifyLines = true) {
	let chain = [];

	// Add each processor to the chain using its addToChain() method.  The processors may choose
	// to add additional dependencies to the chain.
	for (let processor of processors) {
		processor.addToChain(chain);
	}

	// Initialize each processor in the chain.  For each one, include a function that can be
	// called to run through all the gcode from the source and any prior processor streams.
	// This can be used to precompute any data needed by the processor.
	const _initProcessor = async (chainIdx) => {
		// create the preprocessInputGcode method for this processor
		const preprocessInputGcode = function() {
			// Use a throughStream as a placeholder so we can return a stream instead of
			// a promise that resolves to a stream.
			let throughStream = new zstreams.ThroughStream({ objectMode: true });
			let preprocessChain = [];
			const buildPreprocessChain = async() => {
				// This needs to construct a chain of all processors in the chain prior to this
				// one, using copyProcessor() to construct and initialize each one.
				for (let j = 0; j < chainIdx; j++) {
					let copiedProc = await chain[j].copyProcessor();
					copiedProc.gcodeProcessorChain = preprocessChain;
					preprocessChain.push(copiedProc);
				}
				let stream = makeSourceStream(filename);
				for (let gp of preprocessChain) {
					stream.pipe(gp);
					stream = gp;
				}
				stream.pipe(throughStream);
			};
			buildPreprocessChain()
				.catch((err) => throughStream.emit('error', err));
			throughStream.gcodeProcessorChain = processorChain;
			return throughStream;
		};
		chain[chainIdx].preprocessInputGcode = preprocessInputGcode;
		await chain[chainIdx].initProcessor();
	};
	for (let i = 0; i < chain.length; i++) {
		chain[i].gcodeProcessorChain = chain;
		await _initProcessor(i);
	}

	// Construct a chain stream by piping all of the processors together
	let stream = makeSourceStream(filename);
	stream.gcodeProcessorChain = chain;
	for (let gp of chain) {
		stream.pipe(gp);
		stream = gp;
	}

	if (stringifyLines) {
		stream = stream.throughData((gline) => {
			return gline.toString() + '\n';
		});
		stream.gcodeProcessorChain = chain;
	}

	// Return the stream
	return stream;
}

module.exports = GcodeProcessor;
module.exports.buildProcessorChain = buildProcessorChain;
