/*global Future, console, DB, PalmCall, Contacts, checkResult */

var messageQuery = {
	from: "com.palm.message:1",
	where: [
		{ "op": ">", "prop": "_rev", "val": 0 }, //val will be changed in code.
		{"prop": "conversations", "op": "=", "val": null}, //only messages without conversations are of interest
		{"prop": "flags.visible", "op": "=", "val": true} //only visible ones.
	]
};

//can't use Foundations.Activity, because it does not allow immideate activities.
var activity = {
	name: "chatthreader-message-watch",
	description: "Assings new messages to chat threads",
	type: {
		immediate: true,
		priority: "normal",
		persist: true,
		explicit: true,
		power: true,
		powerDebounce: true
	},
	trigger: {
		key: "fired",
		method: "palm://com.palm.db/watch",
		params: { query: messageQuery }
	},
	callback: {
		method: "palm://org.webosports.service.messaging/assingMessagesToThread",
		params: { lastCheckedRev: 0 } //set to same rev as above in code.
	}
};

function setRev (newRev) {
	"use strict";
	activity.trigger.params.query.where[0].val = newRev;
	activity.callback.params.lastCheckedRev = newRev;
	messageQuery.where[0].val = newRev;
}

function debug (msg) {
	console.log(msg);
}

var AssingMessages = function () { "use strict"; };

AssingMessages.prototype.processMessage = function (msg) {
	if (msg.folder === "outbox") {
		if (!msg.to || !msg.to.length) {
			console.error("Need address field. Message " + JSON.stringify(msg) + " skipped.");
			return new Future({returnValue: false});
		}

		//one message can be associated with multiple chattreads if it has multiple recievers.
		var innerFuture = new Future({}); //inner future with dummy result
		msg.to.forEach(function (addrObj) {
			//enque a lot of "processOneMessageAndAddress" functions and let each of them nest one result
			innerFuture.then(this, function processOneMessageAndAddress() {
				innerFuture.nest(this.processMessageAndAddress(msg, addrObj.addr));
			});
		});

		return innerFuture;
	} else {
		if (!msg.from || !msg.from.addr) {
			console.error("Need address field. Message " + JSON.stringify(msg) + " skipped.");
			return new Future({returnValue: false});
		}
		return this.processMessageAndAddress(msg, msg.from.addr);
	}
};

AssingMessages.prototype.processMessageAndAddress = function (msg, address) {
	var future = new Future(), name = "", normalizedAddress;
	if (!msg.serviceName) {
		console.warn("No service name in message, assuming sms.");
		msg.serviceName = "sms";
	}

	//find person from address / phone number:
	if (msg.serviceName === "sms" || msg.serviceName === "mms") {
		future.nest(Contacts.Person.findByPhone(address, {
			includeMatchingItem: false,
			returnAllMatches: false,
		}));
		normalizedAddress = Contacts.PhoneNumber.normalizePhoneNumber(address);
	} else {
		future.nest(Contacts.Person.findByIM(address, msg.serviceName, {
			includeMatchingItem: false,
			returnAllMatches: false
		}));
		normalizedAddress = Contacts.IMAddress.normalizeIm(address);
	}

	future.then(function personCB() {
		var result = checkResult(future), query = { from: "com.palm.chatthread:1"};
		if (result && (result.returnValue === undefined || result.returnValue)) { //result is person
			//TODO: if multiple persons => try to find person by configured account <=> contacts or similar.
			query.where = [ { op: "=", prop: "personId", val: result.getId() } ];
			name = result.getDisplayName();
		} else {
			console.error("No person found " + JSON.stringify(msg) + ".");
			name = normalizedAddress;
			query.where = [ { op: "=", prop: "normalizedAddress", val: normalizedAddress } ];
		}

		future.nest(DB.find(query));
	});

	future.then(function chatthreadCB() {
		var result = checkResult(future), chatthread = { unreadCount: 0, flags: {}};
		if (result.returnValue === true && result.results && result.results.length > 0) {
			if (result.results.length > 1) {
				//multiple threads. What to do? Probably something not right? :-/
				console.warn("Multiple chatthreads found. Will only use first one.");
			}
			chatthread = result.results[0];
		}

		chatthread.displayName = name;
		if (!chatthread.flags) {
			chatthread.flags = {};
		}
		chatthread.flags.visible = true; //have new message.
		chatthread.normalizedAddress = normalizedAddress;
		chatthread.replyAddress = address;
		chatthread.replyService = msg.serviceName;
		chatthread.summary = msg.messageText;
		chatthread.timestamp = msg.localTimestamp || Date.now();
		if (msg.folder === "inbox" && (!msg.flags || (!msg.flags.read && msg.flags.visible))) {
			chatthread.unreadCount += 1;
		}

		future.nest(DB.merge(chatthread));
	});

	future.then(function chatthredMergeCB() {
		var result = checkResult(future);
		if (result.returnValue === true && result.results && result.results.length > 0) {
			if (!msg.conversations) {
				msg.conversations = [];
			}
			msg.conversations.push(result.results[0].id);

			future.nest(DB.merge(msg));
		} else {
			console.error("Could not store chatthread: ", result);
			future.result = { returnValue: false, msg: "Chatthread error"};
		}
	});

	future.then(function msgMergeCB() {
		var result = checkResult(future);
		console.log("Message stored: ", result);
		future.result = {returnValue: true};
	});

	return future;
};

AssingMessages.prototype.run = function (outerFuture) {
	"use strict";
	var args = this.controller.args,
		future = new Future(),
		rev = args.lastCheckedRev || 0,
		newRev = 0;

	setRev(rev);
	future.nest(DB.find(messageQuery, false, false));

	future.then(this, function gotMessages() {
		var result = future.result,
			innerFuture;

		if (result.returnValue) {
			innerFuture = new Future({}); //inner future with dummy result
			result.results.forEach(function (msg) {
				if (msg._rev < newRev) {
					newRev = msg._rev;
				}
				//enque a lot of "processOneMessage" functions and let each of them nest one result
				innerFuture.then(this, function processOneMessage() {
					innerFuture.nest(this.processMessage(msg));
				});
			}, this);

			future.nest(innerFuture);
		} else {
			throw "Could not get messages from db " + JSON.stringify(result);
		}
	});

	future.then(this, function updateRev() {
		var result = future.result; //read result.
		setRev(newRev);
		future.nest(PalmCall.call("palm://com.palm.activitymanager/", "create", {
			activity: activity,
			start: true,
			replace: true
		}));
	});

	future.then(this, function processingFinished() {
		var result = future.result;
		debug("Activity restored: " + JSON.stringify(result));
		outerFuture.result = {};
	});
	return outerFuture;
};
