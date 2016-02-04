/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./list';

import Browser = require('vs/base/browser/browser');
import {IDisposable, Disposable, disposeAll} from 'vs/base/common/lifecycle';
import {IScrollable} from 'vs/base/common/scrollable';
import Event, {Emitter} from 'vs/base/common/event';
import {ScrollableElement} from 'vs/base/browser/ui/scrollbar/scrollableElementImpl';
import DomUtils = require('vs/base/browser/dom');
import {PrefixSumComputer, IPrefixSumIndexOfResult} from 'vs/editor/common/viewModel/prefixSumComputer';
import {StyleMutator} from 'vs/base/browser/styleMutator';

interface IListItem {
	getHeight(): number;
	render(out:string[]): void;
}

interface IViewModelItem {
	cachedHeight: number;
	actual: IListItem;
}

class ViewModelChangedEvent {
	versionId: number;
	start: number;
	deleteCnt: number;
	inserted: number[];

	constructor(versionId:number, start:number, deleteCnt:number, inserted:number[]) {
		this.versionId = versionId;
		this.start = start;
		this.deleteCnt = deleteCnt;
		this.inserted = inserted;
	}
}

class ViewModel extends Disposable {

	private _items: IViewModelItem[];
	private _versionId: number;

	private _onDidChange = this._register(new Emitter<ViewModelChangedEvent>());
	public onDidChange: Event<ViewModelChangedEvent> = this._onDidChange.event;

	constructor(items: IListItem[]) {
		super();
		this._items = this._toMyItems(items);
		this._versionId = 1;
	}

	public getAllHeights(): number[] {
		return this._items.map(i => i.cachedHeight);
	}

	public createViewItem(): ViewItem {
		return new ViewItem(this);
	}

	public getHeightOf(index:number): number {
		return this._items[index].cachedHeight;
	}

	public render(out:string[], index:number): void {
		this._items[index].actual.render(out);
		// console.log('render of index: ' + index + ': ' + this._items[index].content);
		// out.push(this._items[index].content);
	}

	public splice(start:number, deleteCnt: number, _items:IListItem[]): void {
		let items = this._toMyItems(_items);
		this._versionId++;
		// console.log('before items lengh: ' + this._items.length);
		let before = this._items.slice(0, start);
		let after = this._items.slice(start + deleteCnt);

		// console.log('before: ' + before.length);
		// console.log('after: ' + after.length);

		this._items = before.concat(items).concat(after);
		// console.log('new items lengh: ' + this._items.length);
		this._onDidChange.fire(new ViewModelChangedEvent(this._versionId, start, deleteCnt, items.map(i => i.cachedHeight)));
	}

	private _toMyItems(inp:IListItem[]): IViewModelItem[] {
		return inp.map((i) => {
			return {
				cachedHeight: i.getHeight(),
				actual: i
			};
		});
	}
}

class ViewItem {

	private _model: ViewModel;
	private _isDirty: boolean;
	private _domNode: HTMLElement;

	constructor(model:ViewModel) {
		this._model = model;
		this._isDirty = true;
		this._domNode = null;
	}

	public onChanged(): void {
		this._isDirty = true;
	}

	public getDomNode(): HTMLElement {
		return this._domNode;
	}

	public setDomNode(domNode:HTMLElement): void {
		this._domNode = domNode;
	}

	public layoutLine(lineNumber:number, deltaTop:number): void {
		let desiredLineNumber = String(lineNumber);
		let currentLineNumber = this._domNode.getAttribute('lineNumber');
		if (currentLineNumber !== desiredLineNumber) {
			console.log('WHY!!!!');
			this._domNode.setAttribute('lineNumber', desiredLineNumber);
		}
		StyleMutator.setTop(this._domNode, deltaTop);
		StyleMutator.setHeight(this._domNode, this._model.getHeightOf(lineNumber));
	}

	public shouldUpdateHTML(lineNumber: number): boolean {
		return this._isDirty;
	}

	public getLineOuterHTML(out:string[], lineNumber:number, deltaTop:number): void {
		this._isDirty = false;

		out.push('<div lineNumber="');
		out.push(lineNumber.toString());
		out.push('" style="top:');
		out.push(deltaTop.toString());
		out.push('px;height:');
		out.push(String(this._model.getHeightOf(lineNumber)));
		out.push('px;" class="');
		out.push('list-item');
		out.push('">');
		this._model.render(out, lineNumber);
		out.push('</div>');
	}

}

class ListViewEvent {}

class ListViewDimensionChangedEvent extends ListViewEvent {
	newDimension: IDimension;
	constructor(newDimension: IDimension) {
		super();
		this.newDimension = newDimension;
	}
}

class ListViewScrollEvent extends ListViewEvent {
	vertical: boolean;
	horizontal: boolean;
	scrollTop: number;
	scrollLeft: number;
	constructor(data:IScrollEvent) {
		super();
		this.vertical = data.vertical;
		this.horizontal = data.horizontal;
		this.scrollLeft = data.scrollLeft;
		this.scrollTop = data.scrollTop;
	}
}

class ListViewItemsChangedEvent extends ListViewEvent {
	versionId: number;

	changedStart: number;
	changed: number[];

	insertStart: number;
	inserted: number[];

	deleteStart: number;
	deleteCnt: number;

	constructor(e:ViewModelChangedEvent) {
		super();
		this.versionId = e.versionId;

		this.changedStart = e.start;
		this.changed = e.inserted.slice(0, Math.min(e.deleteCnt, e.inserted.length));

		this.insertStart = this.changedStart + this.changed.length;
		this.inserted = e.inserted.slice(this.changed.length);

		this.deleteStart = this.changedStart + this.changed.length;
		this.deleteCnt = e.deleteCnt - this.changed.length;
	}
}

abstract class ListViewListener extends Disposable {

	constructor() {
		super();
	}

	public onBeforeEventsDispatch(): void {

	}

	public abstract onDimensionChanged(e:ListViewDimensionChangedEvent): void;

	public abstract onItemsChanged(e:ListViewItemsChangedEvent): void;

	public onAfterEventsDispatch(): void {

	}
}

class ListViewContext {
	private _listeners:ListViewListener[];
	private _events:ListViewEvent[];
	public model: ViewModel;
	private _onEventAdded:()=>void;

	constructor(model: ViewModel, onEventAdded:()=>void) {
		this.model = model;
		this._listeners = [];
		this._events = [];
		this._onEventAdded = onEventAdded;
	}

	public addEventHandler(eventHandler: ListViewListener): void {
		for (var i = 0, len = this._listeners.length; i < len; i++) {
			if (this._listeners[i] === eventHandler) {
				console.warn('Detected duplicate listener in ViewEventDispatcher', eventHandler);
			}
		}
		this._listeners.push(eventHandler);
	}

	public removeEventHandler(eventHandler:ListViewListener): void {
		for (var i = 0; i < this._listeners.length; i++) {
			if (this._listeners[i] === eventHandler) {
				this._listeners.splice(i, 1);
				break;
			}
		}
	}

	public emitSoon(e:ListViewEvent): void {
		this._events.push(e);
		this._onEventAdded();
	}

	public emitManySoon(e:ListViewEvent): void {
		this._events = this._events.concat(e);
		this._onEventAdded();
	}

	public flush(): void {
		let eventHandlers = this._listeners.slice(0);
		for (let i = 0, len = eventHandlers.length; i < len; i++) {
			eventHandlers[i].onBeforeEventsDispatch();
		}

		while (this._events.length > 0) {
			let e = this._events.shift();

			if (e instanceof ListViewDimensionChangedEvent) {
				for (let i = 0, len = eventHandlers.length; i < len; i++) {
					eventHandlers[i].onDimensionChanged(e);
				}
			} else if (e instanceof ListViewScrollEvent) {
				// nothing for now
			} else if (e instanceof ListViewItemsChangedEvent) {
				for (let i = 0, len = eventHandlers.length; i < len; i++) {
					eventHandlers[i].onItemsChanged(e);
				}
			}else {
				console.log('unknown event', e);
			}
		}

		for (let i = 0, len = eventHandlers.length; i < len; i++) {
			eventHandlers[i].onAfterEventsDispatch();
		}
	}
}

interface IRenderData {
	startIndex: number;
	tops: number[];
	width: number;
	height: number;
	scrollLeft: number;
	scrollTop: number;
	scrollWidth: number;
	scrollHeight: number;
}

class ListViewLayout extends ListViewListener {

	private _ctx: ListViewContext;
	private _scrollable: Scrollable;
	private _scrollbar: ScrollableElement;
	private _layoutData: PrefixSumComputer;

	constructor(ctx:ListViewContext, listItemsDomNode:HTMLElement) {
		super();
		this._ctx = ctx;

		this._layoutData = new PrefixSumComputer(ctx.model.getAllHeights().slice(0));

		this._scrollable = this._register(new Scrollable());
		this._scrollable.setScrollHeight(this._layoutData.getTotalValue());

		this._scrollbar = this._register(new ScrollableElement(listItemsDomNode, {
			scrollable: this._scrollable,
			handleMouseWheel: true
		}, {
			width: 0,
			height: 0
		}));

		this._register(this._scrollable.addInternalSizeChangeListener(() => {
			this._scrollbar.onElementInternalDimensions();
		}));

		this._register(this._scrollable.addScrollListener((e:IScrollEvent) => {
			this._ctx.emitSoon(new ListViewScrollEvent(e))
		}));

		this._ctx.addEventHandler(this);
	}

	public dispose(): void {
		this._ctx.removeEventHandler(this);
		super.dispose();
	}

	// -- events

	public onDimensionChanged(e:ListViewDimensionChangedEvent): void {
		this._scrollable.setWidth(e.newDimension.width);
		this._scrollable.setHeight(e.newDimension.height);
		console.log('SENDING NEW DIMENSIONS!!!');
		this._scrollbar.onElementDimensions({
			width: e.newDimension.width,
			height: e.newDimension.height
		});
	}

	public onItemsChanged(e:ListViewItemsChangedEvent): void {
		// handle changed
		this._layoutData.changeValues(e.changedStart, e.changed);

		// handle deleted
		this._layoutData.removeValues(e.deleteStart, e.deleteCnt);

		// handle inserted
		this._layoutData.insertValues(e.insertStart, e.inserted);
	}

	public onAfterEventsDispatch(): void {
		this._scrollable.setScrollHeight(this._layoutData.getTotalValue());
	}

	// -- end events

	public getScrollableDomNode(): HTMLElement {
		return this._scrollbar.getDomNode();
	}

	public getRenderData(): IRenderData {
		let currentViewport = {
			top: this._scrollable.getScrollTop(),
			left: this._scrollable.getScrollLeft(),
			width: this._scrollable.getWidth(),
			height: this._scrollable.getHeight()
		};

		let offset1 = currentViewport.top;
		let offset2 = currentViewport.top + currentViewport.height;

		let tmp: IPrefixSumIndexOfResult = {
			index: 0,
			remainder: 0
		};

		// console.log('offset1: ' + offset1 + ', offset2: ' + offset2);

		this._layoutData.getIndexOf(offset1, tmp);
		let startIndex = tmp.index;
		// let currentIndex = startIndex;
		let r: number[] = [];

		for (let currentIndex = tmp.index, currentOffset = this._layoutData.getAccumulatedValue(startIndex - 1), len = this._layoutData.getCount(); currentIndex < len; currentIndex++) {
			if (currentOffset > offset2) {
				break;
			}
			r.push(currentOffset);
			currentOffset += this._layoutData.getValue(currentIndex);
		}

		// let cnt = this._layoutData.getCount();
		// while (startIndex < this._layoutData.getCount())
		// console.log('offset1: ' + JSON.stringify(tmp));

		// this._layoutData.getIndexOf(offset2, tmp);
		// console.log('offset2: ' + JSON.stringify(tmp));

		return {
			startIndex: startIndex,
			tops: r,
			width: this._scrollable.getWidth(),
			height: this._scrollable.getHeight(),
			scrollLeft: this._scrollable.getScrollLeft(),
			scrollTop: this._scrollable.getScrollTop(),
			scrollWidth: this._scrollable.getScrollWidth(),
			scrollHeight: this._scrollable.getScrollHeight()
		};
	}
}



class ListView extends ListViewListener {

	public domNode: HTMLElement;
	private _listItemsDomNode: HTMLElement;

	private _ctx: ListViewContext;
	private _layout: ListViewLayout;
	private _renderAnimationFrame: IDisposable;

	constructor(dimension: IDimension, model: ViewModel) {
		super();
		this._ctx = new ListViewContext(model, () => {
			this._scheduleRender();
		});
		this._ctx.addEventHandler(this);
		this._renderAnimationFrame = null;

		this._listItemsDomNode = document.createElement('div');
		this._listItemsDomNode.className = 'list-items';
		this._listItemsDomNode.style.overflow = 'hidden';
		this._listItemsDomNode.style.width = '1000000px';
		this._listItemsDomNode.style.height = '1000000px';
		this._listItemsDomNode.style.position = 'absolute';

		this._layout = this._register(new ListViewLayout(this._ctx, this._listItemsDomNode));

		this.domNode = document.createElement('div');
		this.domNode.appendChild(this._layout.getScrollableDomNode());

		this.acceptDimension(dimension);
		this._scheduleRender();
	}

	public dispose(): void {
		if (this._renderAnimationFrame) {
			this._renderAnimationFrame.dispose();
			this._renderAnimationFrame = null;
		}
		super.dispose();
	}

	// -- events

	public onDimensionChanged(e:ListViewDimensionChangedEvent): void {
		StyleMutator.setWidth(this._layout.getScrollableDomNode(), e.newDimension.width);
		StyleMutator.setHeight(this._layout.getScrollableDomNode(), e.newDimension.height);
	}

	public onItemsChanged(e:ListViewItemsChangedEvent): void {
		// handle changed -> todo: this can be improved to loop less
		for (let i = 0; i < e.changed.length; i++) {
			let changedIndex = e.changedStart + i;
			let myIndex = changedIndex - this._renderedItemsStart;

			if (myIndex < 0) {
				continue;
			}
			if (myIndex >= this._renderedItems.length) {
				continue;
			}

			this._renderedItems[myIndex].onChanged();
		}

		// handle deleted
		{
			let from = Math.max(e.deleteStart - this._renderedItemsStart, 0);
			let to = Math.min(e.deleteStart + e.deleteCnt - 1 - this._renderedItemsStart, this._renderedItems.length - 1);

			// Adjust this._renderedItemsStart
			if (e.deleteStart < this._renderedItemsStart) {
				// Deleting lines starting above the viewport

				if (e.deleteStart + e.deleteCnt - 1 < this._renderedItemsStart) {
					// All deleted lines are above the viewport
					this._renderedItemsStart -= (e.deleteStart + e.deleteCnt - 1 - e.deleteStart + 1);
				} else {
					// Some deleted lines are inside the viewport
					this._renderedItemsStart = e.deleteStart;
				}
			}

			// Remove lines if they fall in the viewport
			if (from <= to) {
				// Remove from DOM
				for (i = from; i <= to; i++) {
					var lineDomNode = this._renderedItems[i].getDomNode();
					if (lineDomNode) {
						this._listItemsDomNode.removeChild(lineDomNode);
					}
				}
				// Remove from array
				this._renderedItems.splice(from, to - from + 1);
			}

		}

		// handle inserted
		{
			if (e.insertStart <= this._renderedItemsStart) {
				// a. We are inserting lines above the viewport
				this._renderedItemsStart += (e.insertStart + e.inserted.length - 1 - e.insertStart + 1);

				// Mark the visible lines as possibly invalid
				// for (i = 0; i < this._lines.length; i++) {
				// 	this._lines[i].onLinesInsertedAbove();
				// }

				// return true;
			} else if (e.insertStart >= this._renderedItemsStart + this._renderedItems.length) {
				// b. We are inserting lines below the viewport
				// return false;
			} else {

				// c. We are inserting lines in the viewport

				var insertFrom = Math.min(e.insertStart - this._renderedItemsStart, this._renderedItems.length - 1);
				var insertTo = Math.min(e.insertStart + e.inserted.length - 1 - this._renderedItemsStart, this._renderedItems.length - 1);
				if (insertFrom <= insertTo) {
					// Insert lines that fall inside the viewport
					for (i = insertFrom; i <= insertTo; i++) {
						this._renderedItems.splice(i, 0, this._createLine());
					}

					// We need to remove lines that are pushed outside the viewport by this insertion,
					// due to the Math.min above on `insertTo`. Otherwise, it is possible for the next line
					// after the insertion to be marked `maybeInvalid` when it should be definitely `invalid`.
					var insertCount = insertTo - insertFrom + 1;
					for (i = 0; i < insertCount; i++) {
						// Remove from array
						var lastLine = this._renderedItems.pop();
						// Remove from DOM
						var lineDomNode = lastLine.getDomNode();
						if (lineDomNode) {
							this._listItemsDomNode.removeChild(lineDomNode);
						}
					}
				}
			}
		}

		console.log("DONE HANDLING!!!!");
		// handle changed
		// this._layoutData.changeValues(e.changedStart, e.changed);

		// // handle deleted
		// this._layoutData.removeValues(e.deleteStart, e.deleteCnt);

		// // handle inserted
		// this._layoutData.insertValues(e.insertStart, e.inserted);
	}


	// -- end events

	public acceptDimension(dimension: IDimension): void {
		this._ctx.emitSoon(new ListViewDimensionChangedEvent(dimension));
	}

	public acceptViewModelEvent(e:ViewModelChangedEvent): void {
		this._ctx.emitSoon(new ListViewItemsChangedEvent(e));
	}

	private _scheduleRender(): void {
		if (this._renderAnimationFrame === null) {
			this._renderAnimationFrame = DomUtils.runAtThisOrScheduleAtNextAnimationFrame(() => {
				this._renderAnimationFrame = null;
				this._flushAccumulatedAndRenderNow();
			}, 100);
		}
	}

	private _flushAccumulatedAndRenderNow(): void {
		this._ctx.flush();
		this._render();
	}

	private _createLine(): ViewItem {
		return this._ctx.model.createViewItem();
	}

	private _renderedItems: ViewItem[] = [];
	private _renderedItemsStart: number = 0;
	private _scrollDomNode: HTMLElement = null;
	private _scrollDomNodeIsAbove: boolean;
	private _render(): void {
		// console.log('I should render now');

		let renderData = this._layout.getRenderData();

		StyleMutator.setWidth(this._listItemsDomNode, renderData.scrollWidth);
		StyleMutator.setHeight(this._listItemsDomNode, renderData.scrollHeight);
		// if (this._hasVerticalScroll || this._hasHorizontalScroll) {
			if (Browser.canUseTranslate3d) {
				var transform = 'translate3d(' + (-renderData.scrollLeft) + 'px, ' + (-renderData.scrollTop) + 'px, 0px)';
				StyleMutator.setTransform(<HTMLElement>this._listItemsDomNode, transform);
			} else {
				// if (this._hasVerticalScroll) {
					StyleMutator.setTop(<HTMLElement>this._listItemsDomNode, -renderData.scrollTop);
				// }
				// if (this._hasHorizontalScroll) {
					StyleMutator.setLeft(<HTMLElement>this._listItemsDomNode, -renderData.scrollLeft);
				// }
			}
			// this._hasVerticalScroll = false;
			// this._hasHorizontalScroll = false;
		// }

		// let renderedItemsLength = this._renderedItems.length;

		var canRemoveScrollDomNode = true;
		if (this._scrollDomNode) {
			var time = this._getScrollDomNodeTime(this._scrollDomNode);
			if ((new Date()).getTime() - time < 1000) {
				canRemoveScrollDomNode = false;
			}
		}

		let startItem = renderData.startIndex;
		let endItem = renderData.startIndex + renderData.tops.length - 1;

		if (canRemoveScrollDomNode && ((this._renderedItemsStart + this._renderedItems.length - 1 < startItem) || (endItem < this._renderedItemsStart))) {
			// There is no overlap whatsoever
			this._renderedItemsStart = startItem;
			this._renderedItems = [];
			for (let x = startItem; x <= endItem; x++) {
				this._renderedItems[x - startItem] = this._createLine();
			}
			this._finishRendering(true, renderData.tops);
			this._scrollDomNode = null;
			return;
		}

		// Update lines which will remain untouched
		this._renderUntouchedLines(
			Math.max(startItem - this._renderedItemsStart, 0),
			Math.min(endItem - this._renderedItemsStart, this._renderedItems.length - 1),
			renderData.tops,
			startItem
		);

		var fromLineNumber: number,
			toLineNumber: number,
			removeCnt: number;

		if (this._renderedItemsStart > startItem) {
			// Insert lines before
			fromLineNumber = startItem;
			toLineNumber = Math.min(endItem, this._renderedItemsStart - 1);
			if (fromLineNumber <= toLineNumber) {
				this._insertLinesBefore(fromLineNumber, toLineNumber, renderData.tops, startItem);

				// Clean garbage above
				if (this._scrollDomNode && this._scrollDomNodeIsAbove) {
					if (this._scrollDomNode.parentNode) {
						this._scrollDomNode.parentNode.removeChild(this._scrollDomNode);
					}
					this._scrollDomNode = null;
				}
			}
		} else if (this._renderedItemsStart < startItem) {
			// Remove lines before
			removeCnt = Math.min(this._renderedItems.length, startItem - this._renderedItemsStart);
			if (removeCnt > 0) {
				this._removeLinesBefore(removeCnt);
			}
		}

		this._renderedItemsStart = startItem;

		if (this._renderedItemsStart + this._renderedItems.length - 1 < endItem) {
			// Insert lines after
			fromLineNumber = this._renderedItemsStart + this._renderedItems.length;
			toLineNumber = endItem;

			if (fromLineNumber <= toLineNumber) {
				this._insertLinesAfter(fromLineNumber, toLineNumber, renderData.tops, startItem);

				// Clean garbage below
				if (this._scrollDomNode && !this._scrollDomNodeIsAbove) {
					if (this._scrollDomNode.parentNode) {
						this._scrollDomNode.parentNode.removeChild(this._scrollDomNode);
					}
					this._scrollDomNode = null;
				}
			}

		} else if (this._renderedItemsStart + this._renderedItems.length - 1 > endItem) {
			// Remove lines after
			fromLineNumber = Math.max(0, endItem - this._renderedItemsStart + 1);
			toLineNumber = this._renderedItems.length - 1;
			removeCnt = toLineNumber - fromLineNumber + 1;

			if (removeCnt > 0) {
				this._removeLinesAfter(removeCnt);
			}
		}

		this._finishRendering(false, renderData.tops);
	}

	private _renderUntouchedLines(startIndex: number, endIndex: number, deltaTop:number[], deltaLN:number): void {
		var i: number,
			lineNumber: number;

		for (i = startIndex; i <= endIndex; i++) {
			lineNumber = this._renderedItemsStart + i;
			var lineDomNode = this._renderedItems[i].getDomNode();
			if (lineDomNode) {
				this._renderedItems[i].layoutLine(lineNumber, deltaTop[lineNumber - deltaLN]);
			}
		}
	}

	private _insertLinesBefore(fromLineNumber: number, toLineNumber: number, deltaTop:number[], deltaLN:number): void {
		var newLines:ViewItem[] = [],
			line:ViewItem,
			lineNumber: number;

		for (lineNumber = fromLineNumber; lineNumber <= toLineNumber; lineNumber++) {
			line = this._createLine();
			newLines.push(line);
		}
		this._renderedItems = newLines.concat(this._renderedItems);
	}

	private _getScrollDomNodeTime(domNode: HTMLElement): number {
		var lastScrollTime = domNode.getAttribute('last-scroll-time');
		if (lastScrollTime) {
			return parseInt(lastScrollTime, 10);
		}
		return 0;
	}

	private _removeIfNotScrollDomNode(domNode: HTMLElement, isAbove: boolean) {
		var time = this._getScrollDomNodeTime(domNode);
		if (!time) {
			this._listItemsDomNode.removeChild(domNode);
			return;
		}

		if (this._scrollDomNode) {
			var otherTime = this._getScrollDomNodeTime(this._scrollDomNode);
			if (otherTime > time) {
				// The other is the real scroll dom node
				this._listItemsDomNode.removeChild(domNode);
				return;
			}

			if (this._scrollDomNode.parentNode) {
				this._scrollDomNode.parentNode.removeChild(this._scrollDomNode);
			}

			this._scrollDomNode = null;
		}

		this._scrollDomNode = domNode;
		this._scrollDomNodeIsAbove = isAbove;
	}

	private _removeLinesBefore(removeCount: number): void {
		var i: number;

		for (i = 0; i < removeCount; i++) {
			var lineDomNode = this._renderedItems[i].getDomNode();
			if (lineDomNode) {
				this._removeIfNotScrollDomNode(lineDomNode, true);
			}
		}
		this._renderedItems.splice(0, removeCount);
	}

	private _insertLinesAfter(fromLineNumber: number, toLineNumber: number, deltaTop:number[], deltaLN:number): void {
		var newLines:ViewItem[] = [],
			line:ViewItem,
			lineNumber: number;

		for (lineNumber = fromLineNumber; lineNumber <= toLineNumber; lineNumber++) {
			line = this._createLine();
			newLines.push(line);
		}
		this._renderedItems = this._renderedItems.concat(newLines);
	}

	private _removeLinesAfter(removeCount: number): void {
		var i: number,
			removeIndex = this._renderedItems.length - removeCount;

		for (i = 0; i < removeCount; i++) {
			var lineDomNode = this._renderedItems[removeIndex + i].getDomNode();
			if (lineDomNode) {
				this._removeIfNotScrollDomNode(lineDomNode, false);
			}
		}
		this._renderedItems.splice(removeIndex, removeCount);
	}

	private _finishRendering(domNodeIsEmpty:boolean, deltaTop:number[]): void {

		var i: number,
			len: number,
			line: ViewItem,
			lineNumber: number,
			hadNewLine = false,
			wasNew: boolean[] = [],
			newLinesHTML: string[] = [],
			hadInvalidLine = false,
			wasInvalid: boolean[] = [],
			invalidLinesHTML: string[] = [];

		for (i = 0, len = this._renderedItems.length; i < len; i++) {
			line = this._renderedItems[i];
			lineNumber = i + this._renderedItemsStart;

			if (line.shouldUpdateHTML(lineNumber)) {
				var lineDomNode = line.getDomNode();
				if (!lineDomNode) {
					// Line is new
					line.getLineOuterHTML(newLinesHTML, lineNumber, deltaTop[i]);
					wasNew[i] = true;
					hadNewLine = true;
				} else {
					// Line is invalid
					line.getLineOuterHTML(invalidLinesHTML, lineNumber, deltaTop[i]);
					wasInvalid[i] = true;
					hadInvalidLine = true;
//					lineDomNode.innerHTML = line.getLineInnerHTML(lineNumber);
				}
			}
		}

		if (hadNewLine) {
			var lastChild = <HTMLElement>this._listItemsDomNode.lastChild;
			if (domNodeIsEmpty || !lastChild) {
				this._listItemsDomNode.innerHTML = newLinesHTML.join('');
			} else {
				lastChild.insertAdjacentHTML('afterend', newLinesHTML.join(''));
			}

			var currChild = <HTMLElement>this._listItemsDomNode.lastChild;
			for (i = this._renderedItems.length - 1; i >= 0; i--) {
				line = this._renderedItems[i];
				if (wasNew[i]) {
					line.setDomNode(currChild);
					currChild = <HTMLElement>currChild.previousSibling;
				}
			}
		}

		if (hadInvalidLine) {

			var hugeDomNode = document.createElement('div');

			hugeDomNode.innerHTML = invalidLinesHTML.join('');

			var lineDomNode:HTMLElement,
				source:HTMLElement;
			for (i = 0; i < this._renderedItems.length; i++) {
				line = this._renderedItems[i];
				if (wasInvalid[i]) {
					source = <HTMLElement>hugeDomNode.firstChild;
					lineDomNode = line.getDomNode();
					lineDomNode.parentNode.replaceChild(source, lineDomNode);
					line.setDomNode(source);
				}
			}
		}

	}
}

interface IDimension {
	width: number;
	height: number;
}

class ListWidget {

	private _domNode: HTMLElement;
	private _model: ViewModel;
	private _modelDisposable: IDisposable[];
	private _view: ListView;
	private _domNodeDimension: IDimension;

	constructor(domNode:HTMLElement) {
		this._domNode = domNode;
		this._domNodeDimension = this._getDomNodeDimension();
		this._model = null;
		this._modelDisposable = [];
		this._view = null;
	}

	public setModel(model: ViewModel): void {
		if (this._view) {
			this._domNode.removeChild(this._view.domNode);
			this._view.dispose();
			this._view = null;
		}
		this._modelDisposable = disposeAll(this._modelDisposable);

		this._model = model;

		if (this._model) {
			this._view = new ListView(this._domNodeDimension, this._model);
			this._domNode.appendChild(this._view.domNode);
			this._modelDisposable.push(this._model.onDidChange((e) => this._view.acceptViewModelEvent(e)));
		}
	}

	private _getDomNodeDimension(): IDimension {
		return {
			width: this._domNode.clientWidth,
			height: this._domNode.clientHeight
		};
	}

	public layout(dimension?: IDimension) {
		if (dimension) {
			this._domNodeDimension = dimension;
		} else {
			this._domNodeDimension = this._getDomNodeDimension();
		}

		if (this._view) {
			this._view.acceptDimension(this._domNodeDimension);
		}
	}

}

interface IScrollEvent {
	horizontal: boolean;
	vertical: boolean;
	scrollTop: number;
	scrollLeft: number;
}

class Scrollable extends Disposable implements IScrollable {
	private scrollTop: number;
	private scrollLeft: number;
	private scrollWidth: number;
	private scrollHeight: number;
	private width: number;
	private height: number;

	constructor() {
		super();

		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.scrollWidth = 0;
		this.scrollHeight = 0;
		this.width = 0;
		this.height = 0;
	}

	public dispose(): void {
		super.dispose();
	}

	// ------------ (visible) width

	public getWidth(): number {
		return this.width;
	}

	public setWidth(width: number): void {
		width = Math.floor(width);
		if (width < 0) {
			width = 0;
		}

		if (this.width !== width) {
			this.width = width;

			// Revalidate
			this.setScrollWidth(this.scrollWidth);
			this.setScrollLeft(this.scrollLeft);
		}
	}

	// ------------ scroll width

	public getScrollWidth(): number {
		return this.scrollWidth;
	}

	public setScrollWidth(scrollWidth:number): void {
		scrollWidth = Math.floor(scrollWidth);
		if (scrollWidth < this.width) {
			scrollWidth = this.width;
		}

		if (this.scrollWidth !== scrollWidth) {
			this.scrollWidth = scrollWidth;

			// Revalidate
			this.setScrollLeft(this.scrollLeft);

			this._emitInternalSizeEvent();
		}
	}

	// ------------ scroll left

	public getScrollLeft(): number {
		return this.scrollLeft;
	}

	public setScrollLeft(scrollLeft:number): void {
		scrollLeft = Math.floor(scrollLeft);
		if (scrollLeft < 0) {
			scrollLeft = 0;
		}
		if (scrollLeft + this.width > this.scrollWidth) {
			scrollLeft = this.scrollWidth - this.width;
		}

		if (this.scrollLeft !== scrollLeft) {
			this.scrollLeft = scrollLeft;

			this._emitScrollEvent(false, true);
		}
	}

	// ------------ (visible) height

	public getHeight(): number {
		return this.height;
	}

	public setHeight(height: number): void {
		console.log('setHeight called!!!');
		height = Math.floor(height);
		if (height < 0) {
			height = 0;
		}

		if (this.height !== height) {
			this.height = height;

			// Revalidate
			this.setScrollHeight(this.scrollHeight);
			this.setScrollTop(this.scrollTop);
		}
	}

	// ------------ scroll height

	public getScrollHeight(): number {
		return this.scrollHeight;
	}

	public setScrollHeight(scrollHeight: number): void {
		scrollHeight = Math.floor(scrollHeight);
		if (scrollHeight < this.height) {
			scrollHeight = this.height;
		}

		if (this.scrollHeight !== scrollHeight) {
			this.scrollHeight = scrollHeight;

			// Revalidate
			this.setScrollTop(this.scrollTop);

			this._emitInternalSizeEvent();
		}
	}

	// ------------ scroll top

	public getScrollTop(): number {
		return this.scrollTop;
	}

	public setScrollTop(scrollTop:number): void {
		scrollTop = Math.floor(scrollTop);
		if (scrollTop < 0) {
			scrollTop = 0;
		}
		if (scrollTop + this.height > this.scrollHeight) {
			scrollTop = this.scrollHeight - this.height;
		}

		if (this.scrollTop !== scrollTop) {
			this.scrollTop = scrollTop;

			this._emitScrollEvent(true, false);
		}
	}

	// ------------ events

	private _onDidScroll = this._register(new Emitter<IScrollEvent>());
	public addScrollListener: Event<IScrollEvent> = this._onDidScroll.event;

	// static _SCROLL_EVENT = 'scroll';
	private _emitScrollEvent(vertical:boolean, horizontal:boolean): void {
		var e:IScrollEvent = {
			vertical: vertical,
			horizontal: horizontal,
			scrollTop: this.scrollTop,
			scrollLeft: this.scrollLeft
		};
		this._onDidScroll.fire(e);
	}

	private _onDidInternalSizeChange = this._register(new Emitter<void>());
	public addInternalSizeChangeListener: Event<void> = this._onDidInternalSizeChange.event;

	private _emitInternalSizeEvent(): void {
		this._onDidInternalSizeChange.fire(void 0);
	}
}


var container = document.createElement('div');
container.style.width = '500px';
container.style.height = '500px';
container.style.background = 'orange';
container.style.fontSize = '15px';
container.style.position = 'fixed';
container.style.zIndex = '100';
document.body.appendChild(container);

function randInt(min:number, max:number): number {
	return min + Math.round(Math.random() * (max - min));
}

function randChar(): string {
	return String.fromCharCode(randInt('a'.charCodeAt(0), 'z'.charCodeAt(0)));
}

function randStr(): string {
	var r = '';
	for (var i = 0; i < 20; i++) {
		r += randChar();
	}
	return r;

}

class MySpecialItem implements IListItem {

	private _height: number;
	private _content: string;

	constructor(height:number, content:string) {
		this._height = height;
		this._content = content;
	}

	getHeight(): number {
		return this._height;
	}

	render(out:string[]): void {
		out.push('<span>');
		// ATTN!!!! this._content must be escaped of special HTLM chars!!!
		out.push(this._content);
		out.push('</span>');
	}

}

{
	let w = new ListWidget(container);
	let items:IListItem[] = [];
	for (var i = 0; i < 1000; i++) {
		items.push(new MySpecialItem(
			randInt(20, 35),
			i + '. LINE ' + i + ', '+ '. LINE ' + i+ '. LINE ' + i+ '. LINE ' + i// + randStr(),
		));
	}
	let vm = new ViewModel(items);
	w.setModel(vm);

	setTimeout(() => {
		let newItems: IListItem[] = [];
		for (let i = 0; i < 1000; i++) {
			newItems.push(new MySpecialItem(
				randInt(20, 35),
				i + '. NEW LINE ' + i + ', '+ '. NEW LINE ' + i+ '. NEW LINE ' + i+ '. NEW LINE ' + i// + randStr(),
			));
		}

		vm.splice(5, 50, newItems);
	}, 2000);

}
